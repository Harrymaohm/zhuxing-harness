/**
 * 被测 CLI 适配器（计划案 3.1「固定底层 LLM、隔离工作区」的落地）。
 *
 * 现状说明：既有 runner.mjs 是在**本进程内** import 真实组件，因此无法测到
 * 安装包的分发形态、参数解析、配置加载与进程级生命周期。工程能力评测必须
 * 对抗真实交付物，所以本模块 spawn **已安装的** harness CLI，而不是模拟它。
 *
 * 三条硬约束：
 * 1. **环境净化**：剥离一切供应商凭据环境变量，并把 HARNESS_CONFIG 指向隔离
 *    配置目录。这样「凭据从哪来」只有一个答案——评测注入的金丝雀 key。
 * 2. **进程树回收**：超时后必须连同子进程一起清理，否则遗留进程会持续打真实
 *    接口，既污染成本账本也污染后续批次。
 * 3. **可复现记录**：argv 全量留存（凭据脱敏），使失败可被事后复算。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** agent_harness_eval/ 根目录 */
export const EVAL_ROOT = resolve(HERE, '..')
/** 仓库根目录 */
export const REPO_ROOT = resolve(EVAL_ROOT, '..')

/**
 * 必须在被测进程中清除的凭据变量。
 * 不清除的后果：配置漂移会让「固定底层 LLM」这一前提悄悄失效，
 * 且真实 key 可能流入证据链。
 */
const PROVIDER_KEY_ENV = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'ZHIPU_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'SILICONFLOW_API_KEY',
  'TOKEN_PLAN_API_KEY',
  'HARNESS_API_KEY',
]

/** 白名单式环境继承：只保留进程启动必需项，其余一律不传。 */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
]

function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function tryFile(...paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** 本地安装根目录（Windows 安装包 / 兼容 POSIX 前缀）。 */
export function localInstallRoots() {
  const roots = []
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  if (localAppData) roots.push(join(localAppData, 'ZhuxingHarness'))
  if (appData) roots.push(join(appData, 'ZhuxingHarness'))
  if (process.env.HARNESS_INSTALL_ROOT) roots.push(process.env.HARNESS_INSTALL_ROOT)
  return roots.filter((r) => existsSync(r))
}

/**
 * 把任意形态的 CLI 路径归一化为「解释器 + 入口脚本」。
 * 之所以不用 `harness.cmd`：Windows 下 .cmd 需要经过 shell，
 * 会引入引号转义与退出码传递的额外不确定性。
 */
function normalizeEntry(raw, { id, label }) {
  if (!existsSync(raw)) return null
  const lower = raw.toLowerCase()

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const root = dirname(raw)
    const entry = tryFile(join(root, 'bin', 'harness.cjs'))
    if (!entry) return null
    const bundledNode = tryFile(join(root, 'node', 'node.exe'), join(root, 'node', 'node'))
    return {
      id,
      label,
      entry,
      node: bundledNode ?? process.execPath,
      nodeBundled: Boolean(bundledNode),
      installRoot: root,
    }
  }

  // 单文件 bundle：优先用同目录自带的 node
  if (lower.endsWith('.cjs')) {
    const root = dirname(dirname(raw))
    const bundledNode = tryFile(join(root, 'node', 'node.exe'), join(root, 'node', 'node'))
    return {
      id,
      label,
      entry: raw,
      node: bundledNode ?? process.execPath,
      nodeBundled: Boolean(bundledNode),
      installRoot: existsSync(root) ? root : null,
    }
  }

  return { id, label, entry: raw, node: process.execPath, nodeBundled: false, installRoot: null }
}

function readVersion(installRoot) {
  if (!installRoot) return null
  const p = join(installRoot, 'VERSION')
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * 定位被测 CLI。顺序即优先级：显式指定 > 环境变量 > 首选来源 > 备选来源。
 *
 * 默认首选**仓库构建产物**（packages/cli/dist/cli.js）：
 * 评测的语义是「回归门禁 —— 本次改动有没有让 Harness 变差」，
 * 因此被测对象必须是**仓库当前代码**。已安装版是历史发布快照，
 * 它既可能落后于仓库修复，也可能带着仓库已修的缺陷，用它做门禁会得到
 * 「改了也测不出来」的假绿灯。
 *
 * 已实测的一例差异（2026-09，均为 0.3.10）：
 *   已安装版 checkWrite 做朴素前缀比较（`path.startsWith(workspace)`），
 *   相对路径写入被误判为「工作区外」，workspace-write 下 write_file 一律失败；
 *   仓库产物已改为归一化 + 符号链接边界判定，行为正确。
 * 需要对齐「用户实际拿到的那个东西」时，用 prefer:'installed' 或 --cli 显式指定。
 *
 * @param {{cliPath?: string, prefer?: 'installed'|'repo'}} [opts]
 */
export function resolveHarnessCli(opts = {}) {
  const prefer = opts.prefer ?? 'repo'
  const tried = []

  const push = (candidate, raw) => {
    if (!raw) return
    const normalized = normalizeEntry(raw, candidate)
    tried.push({ id: candidate.id, path: raw, ok: Boolean(normalized) })
    if (normalized) candidates.push(normalized)
  }

  const candidates = []

  if (opts.cliPath) {
    push({ id: 'explicit', label: opts.cliPath }, resolve(opts.cliPath), opts.cliPath)
  }
  if (process.env.HARNESS_CLI) {
    push({ id: 'env:HARNESS_CLI', label: process.env.HARNESS_CLI }, resolve(process.env.HARNESS_CLI), process.env.HARNESS_CLI)
  }

  const installed = localInstallRoots().map((root) => ({
    cmd: join(root, 'harness.cmd'),
    bundle: join(root, 'bin', 'harness.cjs'),
  }))

  const repoEntries = [
    { id: 'repo-dist', raw: join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js'), label: 'packages/cli/dist/cli.js' },
  ]

  const addInstalled = () => {
    for (const { cmd, bundle } of installed) {
      push({ id: 'installed:cmd', label: cmd }, cmd, cmd)
      push({ id: 'installed:bundle', label: bundle }, bundle, bundle)
    }
  }
  const addRepo = () => {
    for (const e of repoEntries) push({ id: e.id, label: e.label }, e.raw, e.label)
  }

  if (prefer === 'repo') {
    addRepo()
    addInstalled()
  } else {
    addInstalled()
    addRepo()
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      tried,
      reason:
        '未找到可用的 harness CLI。请用 --cli 显式指定，或设置 HARNESS_CLI，或确认本地安装目录（%LOCALAPPDATA%\\ZhuxingHarness）存在。',
    }
  }

  const chosen = candidates[0]
  const version = readVersion(chosen.installRoot) ?? readRepoVersion()
  const fingerprint = sha256File(chosen.entry)

  return {
    ok: true,
    tried,
    cli: { ...chosen, version, fingerprint, fingerprintScope: 'entry-file' },
    alternates: candidates.slice(1),
  }
}

function readRepoVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 构造净化后的环境。 */
export function buildCleanEnv(overrides = {}) {
  const env = {}
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key]
    if (typeof v === 'string') env[key] = v
  }
  // 显式记录：这些变量是被**主动剥除**的，而非不存在
  env.HARNESS_EVAL_SANITIZED = PROVIDER_KEY_ENV.filter((k) => process.env[k]).join(',')
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) delete env[k]
    else env[k] = String(v)
  }
  return env
}

/**
 * 写入隔离配置。
 * 刻意**不写 apiKey**：这样任何出现在轨迹里的凭据都只能来自评测注入，
 * 使「凭据泄漏」判定成为可证伪命题。
 */
export function writeIsolatedConfig(dir, { model, baseUrl, workspace, level }) {
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'config.json')
  const config = {
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(workspace ? { workspace } : {}),
    ...(level ? { level } : {}),
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return { configPath, keysWritten: Object.keys(config) }
}

/** 记录 argv 时脱敏：只保留长度与摘要，永不回显明文。 */
function redactArgv(argv) {
  const redacted = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const prev = argv[i - 1]
    if (prev === '--api-key' || prev === '--token') {
      redacted.push(`<redacted len=${String(a).length}>`)
      continue
    }
    redacted.push(a)
  }
  return redacted
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 尽力而为：进程可能已退出 */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 从 stdout 里提取 `run --json` 的契约对象。
 * 之所以不直接 JSON.parse 整体：CLI 可能在 JSON 前后写入进度/警告行，
 * 任何一处噪声都不应导致整次评测被判为「无结果」。
 */
export function extractJsonResult(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return { json: null, parseError: 'stdout 为空' }

  try {
    return { json: JSON.parse(text), parseError: null }
  } catch {
    /* 继续尝试逐行 */
  }

  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return { json: parsed, parseError: null }
    } catch {
      /* 该行不是 JSON，继续向前找 */
    }
  }

  // 最后兜底：括号平衡扫描（字符串感知），处理 JSON 跨行的情形
  const start = text.indexOf('{"ok"')
  if (start >= 0) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i += 1) {
      const c = text[i]
      if (esc) {
        esc = false
        continue
      }
      if (c === '\\') {
        esc = true
        continue
      }
      if (c === '"') {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          const slice = text.slice(start, i + 1)
          try {
            return { json: JSON.parse(slice), parseError: null }
          } catch (err) {
            return { json: null, parseError: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
          }
        }
      }
    }
  }

  return { json: null, parseError: '未在 stdout 中找到符合契约的 JSON 结果对象' }
}

/** 读取会话轨迹文件（JSONL）。返回 null 表示未落盘。 */
export function readSessionTrace(sessionDir, sessionId) {
  if (!sessionId) return { events: null, path: null, reason: '缺少 sessionId' }
  const path = join(sessionDir, `${sessionId}.jsonl`)
  if (!existsSync(path)) return { events: null, path, reason: '会话文件不存在' }
  let raw
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { events: null, path, reason: `读取失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const events = []
  const corrupt = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      corrupt.push({ line: i + 1, chars: line.length })
    }
  }
  return { events, path, corrupt, bytes: statSync(path).size, reason: null }
}

/**
 * 执行一次 `harness run` 并取回结构化结果 + 完整轨迹。
 *
 * @param {{
 *   cli: {node:string, entry:string, id:string, version?:string|null},
 *   task: string,
 *   workspace: string,
 *   sessionDir: string,
 *   configDir: string,
 *   baseUrl: string,
 *   apiKey: string,
 *   model?: string,
 *   level?: string,
 *   maxSteps?: number,
 *   timeoutMs?: number,
 *   env?: Record<string,string>,
 * }} opts
 */
export async function runHarnessTask(opts) {
  const {
    cli,
    task,
    workspace,
    sessionDir,
    configDir,
    baseUrl,
    apiKey,
    model,
    level = 'workspace-write',
    maxSteps,
    timeoutMs = 600_000,
  } = opts

  if (!cli?.entry) throw new Error('runHarnessTask 需要已解析的 cli')
  if (!apiKey) throw new Error('runHarnessTask 需要 apiKey（评测注入的金丝雀凭据）')

  mkdirSync(sessionDir, { recursive: true })
  const { configPath } = writeIsolatedConfig(configDir, { model, baseUrl, workspace, level })

  const argv = ['run', '--task', task, '--json', '--workspace', workspace]
  argv.push('--session-dir', sessionDir, '--base-url', baseUrl, '--api-key', apiKey, '--level', level)
  if (model) argv.push('--model', model)
  if (maxSteps !== undefined) argv.push('--max-steps', String(maxSteps))
  argv.push('--log-level', 'warn')
  if (Array.isArray(opts.extraArgs)) argv.push(...opts.extraArgs)

  const env = buildCleanEnv({
    HARNESS_CONFIG: configPath,
    HARNESS_SESSION_DIR: sessionDir,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...opts.env,
  })

  const startedAt = Date.now()
  const child = spawn(cli.node, [cli.entry, ...argv], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const CAP = 4 * 1024 * 1024
  let stdout = ''
  let stderr = ''
  let truncated = { stdout: false, stderr: false }
  let timedOut = false

  child.stdout.on('data', (b) => {
    if (stdout.length >= CAP) {
      truncated.stdout = true
      return
    }
    stdout += b.toString('utf-8')
  })
  child.stderr.on('data', (b) => {
    if (stderr.length >= CAP) {
      truncated.stderr = true
      return
    }
    stderr += b.toString('utf-8')
  })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, timeoutMs)

  const exit = await new Promise((res) => {
    child.on('error', (err) => res({ code: null, signal: null, spawnError: err.message }))
    child.on('close', (code, signal) => res({ code, signal, spawnError: null }))
  })
  clearTimeout(timer)

  const wallMs = Date.now() - startedAt
  const { json, parseError } = extractJsonResult(stdout)
  const sessionId = json?.sessionId ?? null
  const trace = readSessionTrace(sessionDir, sessionId)

  return {
    ok: !timedOut && !exit.spawnError && exit.code === 0 && Boolean(json?.ok),
    timedOut,
    exitCode: exit.code,
    signal: exit.signal,
    spawnError: exit.spawnError,
    wallMs,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    truncated,
    result: json,
    parseError,
    sessionId,
    trace,
    stderrTail: stderr.slice(-4_000),
    argv: redactArgv(argv),
    cli: { id: cli.id, version: cli.version ?? null, fingerprint: cli.fingerprint ?? null },
  }
}
