/**
 * 隔离工作区（计划案 3.1「隔离工作区」的可移植落地）。
 *
 * 与计划案原稿的差异及理由：原稿要求 Docker 隔离。本实现改用 **git worktree +
 * fixture** 双模式，原因是——(a) 评测口径是「用本地已安装好的跑来测试」，Docker
 * 会让被测物与安装包形态脱钩；(b) Windows 上 Docker 的挂载/权限开销极高，
 * 会污染时间与成本指标。两种模式都具备计划案要求的两条性质：
 * **零交叉污染**（每个任务一棵独立的树）与**可复现**（基线提交可追溯）。
 *
 * 「基线提交」是这里的关键设计：先按 ref 建树、跑 setupCommands，再把结果固化成
 * 一个提交。这样后续 diff 反映的**只有 Agent 的改动**，setup 产生的
 * node_modules 等噪声不会混进改动质量评分。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, cpSync } from 'node:fs'
import { join } from 'node:path'

/** 在指定目录执行 shell 命令（跨平台：Windows 走 cmd.exe，POSIX 走 /bin/sh）。 */
export function runShell(command, { cwd, timeoutMs = 600_000, env, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (b) => {
      if (stdout.length < maxBytes) stdout += b.toString('utf-8')
    })
    child.stderr.on('data', (b) => {
      if (stderr.length < maxBytes) stderr += b.toString('utf-8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } catch {
          /* 尽力而为 */
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 同上 */
          }
        }
      }
    }, timeoutMs)

    child.on('error', (err) =>
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut, wallMs: Date.now() - startedAt, spawnError: err.message }),
    )
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, wallMs: Date.now() - startedAt, spawnError: null })
    })
  })
}

/**
 * 执行 git 子命令（不经 shell，避免路径含空格/中文时的转义问题）。
 * 注意：本仓库路径为中文（筑星Harness），因此**必须**走 argv 数组形式。
 */
export async function git(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 尽力而为 */
      }
    }, timeoutMs)
    child.stdout.on('data', (b) => (stdout += b.toString('utf-8')))
    child.stderr.on('data', (b) => (stderr += b.toString('utf-8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 仓库指纹：用于「评测过程中不得改动被测仓库」门禁。 */
export async function repoFingerprint(repoRoot) {
  const head = await git(['rev-parse', 'HEAD'], { cwd: repoRoot })
  const status = await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: repoRoot })
  const stashed = await git(['stash', 'list'], { cwd: repoRoot })
  const lines = status.stdout.split('\n').filter(Boolean)
  return {
    head: head.ok ? head.stdout.trim() : null,
    dirtyTrackedCount: lines.length,
    statusDigest: createHash('sha256').update(status.stdout).digest('hex').slice(0, 16),
    stashCount: stashed.ok ? stashed.stdout.split('\n').filter(Boolean).length : null,
  }
}

function sanitizeSegment(text) {
  return String(text).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
}

export function makeWorkspacePath(baseDir, taskId, runIndex) {
  const dir = join(baseDir, `${sanitizeSegment(taskId)}__r${runIndex}`)
  mkdirSync(baseDir, { recursive: true })
  return dir
}

/**
 * 建树。返回的 `baselineCommit` 之后所有比较都以它为基准。
 *
 * @param {{
 *   task: { id: string, repository: { mode: 'worktree'|'fixture', path?: string, ref?: string, fixture?: string, setupCommands?: string[] } },
 *   dir: string,
 *   repoRoot: string,
 *   setupTimeoutMs?: number,
 * }} opts
 */
export async function prepareWorkspace(opts) {
  const { task, dir, repoRoot, setupTimeoutMs = 300_000 } = opts
  const repo = task.repository ?? {}
  const mode = repo.mode ?? 'worktree'
  const steps = []

  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  if (mode === 'worktree') {
    const source = repo.path ? (existsSync(repo.path) ? repo.path : join(repoRoot, repo.path)) : repoRoot
    const add = await git(['worktree', 'add', '--detach', dir, repo.ref ?? 'HEAD'], { cwd: source })
    steps.push({ step: 'worktree-add', ok: add.ok, stderr: add.stderr.trim().slice(0, 400) })
    if (!add.ok) {
      return { ok: false, mode, dir, steps, reason: `git worktree add 失败：${add.stderr.trim() || '未知原因'}` }
    }
  } else if (mode === 'fixture') {
    const fixture = repo.fixture ? (existsSync(repo.fixture) ? repo.fixture : join(repoRoot, repo.fixture)) : null
    if (!fixture || !existsSync(fixture)) {
      return { ok: false, mode, dir, steps, reason: `fixture 目录不存在：${repo.fixture}` }
    }
    mkdirSync(dir, { recursive: true })
    cpSync(fixture, dir, { recursive: true })
    const init = await git(['init', '-q', '-b', 'main'], { cwd: dir })
    steps.push({ step: 'git-init', ok: init.ok, stderr: init.stderr.trim().slice(0, 400) })
    await git(['config', 'user.email', 'eval@harness.local'], { cwd: dir })
    await git(['config', 'user.name', 'harness-eval'], { cwd: dir })
    await git(['config', 'commit.gpgsign', 'false'], { cwd: dir })
    await git(['add', '-A'], { cwd: dir })
    const commit = await git(['commit', '-q', '-m', 'eval: fixture baseline'], { cwd: dir })
    steps.push({ step: 'fixture-commit', ok: commit.ok, stderr: commit.stderr.trim().slice(0, 400) })
  } else {
    return { ok: false, mode, dir, steps, reason: `未知 repository.mode：${mode}` }
  }

  for (const cmd of repo.setupCommands ?? []) {
    const res = await runShell(cmd, { cwd: dir, timeoutMs: setupTimeoutMs })
    steps.push({
      step: `setup:${cmd}`,
      ok: res.code === 0 && !res.timedOut,
      code: res.code,
      timedOut: res.timedOut,
      wallMs: res.wallMs,
      stderr: res.stderr.trim().slice(0, 400),
    })
    if (res.code !== 0 || res.timedOut) {
      return { ok: false, mode, dir, steps, reason: `setup 命令失败：${cmd}` }
    }
  }

  // 固化基线：setup 的副作用（node_modules、生成的锁文件等）归入基线，不计入 Agent 改动
  await git(['config', 'user.email', 'eval@harness.local'], { cwd: dir })
  await git(['config', 'user.name', 'harness-eval'], { cwd: dir })
  await git(['config', 'commit.gpgsign', 'false'], { cwd: dir })
  await git(['add', '-A'], { cwd: dir })
  const dirty = await git(['status', '--porcelain=v1'], { cwd: dir })
  let baselineCommit
  if (dirty.stdout.trim()) {
    const commit = await git(['commit', '-q', '-m', 'eval: baseline (post-setup)'], { cwd: dir })
    steps.push({ step: 'baseline-commit', ok: commit.ok, stderr: commit.stderr.trim().slice(0, 400) })
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir })
  baselineCommit = head.stdout.trim() || null
  steps.push({ step: 'baseline-head', ok: head.ok, commit: baselineCommit })

  return { ok: true, mode, dir, steps, baselineCommit, reason: null }
}

/**
 * 采集改动清单。
 * 用 `<baselineCommit>` 作为比较基准而非 `HEAD`：Agent 可能自己 `git commit`，
 * 那样以 HEAD 为基准会得出「无改动」的错误结论。
 */
export async function collectChangeManifest(workspace, baselineCommit, { patchCapBytes = 1_500_000 } = {}) {
  const base = baselineCommit
  if (!base) return { ok: false, reason: '缺少 baselineCommit，无法计算改动' }

  await git(['add', '-A'], { cwd: workspace })

  const nameStatus = await git(['diff', '--cached', '--name-status', base], { cwd: workspace })
  const numstat = await git(['diff', '--cached', '--numstat', base], { cwd: workspace })
  const stat = await git(['diff', '--cached', '--stat', base], { cwd: workspace })
  const patch = await git(['diff', '--cached', base], { cwd: workspace })
  const headAfter = await git(['rev-parse', 'HEAD'], { cwd: workspace })
  const log = await git(['log', '--oneline', `${base}..HEAD`], { cwd: workspace })

  const numstatMap = new Map()
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue
    const [added, removed, path] = line.split('\t')
    numstatMap.set(path, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    })
  }

  const files = []
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const status = parts[0]
    const path = parts[parts.length - 1]
    const ns = numstatMap.get(path) ?? { added: null, removed: null }
    files.push({ path, status, added: ns.added, removed: ns.removed, binary: ns.added === null })
  }

  const totals = files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      added: acc.added + (f.added ?? 0),
      removed: acc.removed + (f.removed ?? 0),
      binary: acc.binary + (f.binary ? 1 : 0),
    }),
    { files: 0, added: 0, removed: 0, binary: 0 },
  )

  const rawPatch = patch.stdout
  const truncated = rawPatch.length > patchCapBytes

  return {
    ok: true,
    baselineCommit: base,
    headAfter: headAfter.stdout.trim() || null,
    agentCommits: log.ok ? log.stdout.split('\n').filter(Boolean) : [],
    files,
    totals,
    patch: truncated ? rawPatch.slice(0, patchCapBytes) : rawPatch,
    patchTruncated: truncated,
    patchBytes: rawPatch.length,
    patchDigest: createHash('sha256').update(rawPatch).digest('hex').slice(0, 16),
    stat: stat.stdout.trim(),
    reason: null,
  }
}

/** 拆除工作区。必须幂等：失败路径上也可能被调用。 */
export async function teardownWorkspace({ mode, dir, repoRoot }) {
  const result = { removed: false, pruned: false, errors: [] }
  try {
    if (mode === 'worktree' && dir) {
      const rm = await git(['worktree', 'remove', '--force', dir], { cwd: repoRoot })
      if (!rm.ok) result.errors.push(`worktree remove: ${rm.stderr.trim()}`)
      const prune = await git(['worktree', 'prune'], { cwd: repoRoot })
      result.pruned = prune.ok
    }
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    result.removed = !existsSync(dir)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
  }
  return result
}

/** 工作区快照摘要：用于事后复算（不落全量文件内容，只留结构与摘要）。 */
export function workspaceSummary(dir) {
  if (!existsSync(dir)) return null
  const st = statSync(dir)
  return { dir, exists: true, isDirectory: st.isDirectory() }
}
