import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 更新清单（发布方自建 HTTP 静态服务上的 manifest.json）。 */
export interface UpdateManifest {
  latestVersion: string
  channel?: string
  publishedAt?: string
  /** 增量包文件名（相对 manifest 所在目录）。 */
  updateFile: string
  /** 增量包 sha256（hex）。 */
  sha256: string
  size?: number
  releaseNotes?: string
  /** 最低可升级版本（低于此版本需手动重装）。 */
  minVersion?: string
  /**
   * 安装包轨（与 zip 增量轨分轨）：Electron 运行时无法用 zip 承载，
   * 只能通过新安装包分发；发布方在 manifest 声明 installer，客户端据此提示重装。
   */
  installer?: { version: string; url?: string; notes?: string }
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  releaseNotes?: string
  manifest?: UpdateManifest
  /** 安装包轨：manifest.installer 声明了比当前版本更新的安装包时给出下载指引。 */
  installerUpdate?: { version: string; url?: string; notes?: string }
}

/** 安装包轨判定：installer.version 高于当前版本才提示重装（纯函数，便于单测）。 */
export function installerUpdateAvailable(
  manifest: Pick<UpdateManifest, 'installer'>,
  current: string,
): { version: string; url?: string; notes?: string } | undefined {
  const installer = manifest.installer
  if (!installer?.version) return undefined
  return compareSemver(installer.version, current) > 0 ? { version: installer.version, url: installer.url, notes: installer.notes } : undefined
}

export interface ApplyResult {
  ok: boolean
  fromVersion: string
  toVersion: string
  backedUpTo?: string
  error?: string
}

/** 应用内更新状态（写入 update-status.json，供 Web UI 展示结果 / 回滚通知 / 自检报告）。 */
export interface UpdateStatus {
  status: 'success' | 'rolled-back' | 'failed'
  fromVersion: string
  toVersion: string
  message: string
  /** 《本次内核变更说明》自检报告内容（随更新包下发）。 */
  changelog?: string
  appliedAt: number
}

/** 状态文件路径（安装根目录）。 */
function statusFilePath(root: string): string {
  return join(root, 'update-status.json')
}

/** 写入更新状态（供 Web UI 读取）。 */
export function writeUpdateStatus(root: string, status: UpdateStatus): void {
  try {
    writeFileSync(statusFilePath(root), `${JSON.stringify(status, null, 2)}\n`, 'utf-8')
  } catch {
    /* 状态写入失败不阻塞更新流程 */
  }
}

/** 读取更新状态（Web 外壳调 /api/update/status 时使用；不存在时返回 null）。 */
export function readUpdateStatus(root: string): UpdateStatus | null {
  const p = statusFilePath(root)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as UpdateStatus
  } catch {
    return null
  }
}

/** 比较两个 semver（无 prerelease 简化版），a > b 返回正数。 */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 当前版本：优先读安装目录 VERSION，否则回退构建注入版本。 */
export function currentVersion(): string {
  const root = installRoot()
  if (root) {
    try {
      const v = readFileSync(join(root, 'VERSION'), 'utf-8').trim()
      if (v) return v
    } catch {
      /* ignore */
    }
  }
  return (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__ ?? '0.0.0'
}

/** 安装根目录（安装态由 harness.cmd 注入 HARNESS_ROOT；开发态返回 null）。 */
export function installRoot(): string | null {
  return process.env.HARNESS_ROOT ?? null
}

/** 读取安装目录内的 VERSION 文件。 */
function readVersionFromRoot(root: string): string {
  try {
    return readFileSync(join(root, 'VERSION'), 'utf-8').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 从更新源拉取 manifest.json。 */
export async function fetchManifest(url: string): Promise<UpdateManifest> {
  const manifestUrl = url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`获取更新清单失败（HTTP ${res.status}）`)
  return (await res.json()) as UpdateManifest
}

/** 检查更新：对比本地版本与远程最新版本。 */
export async function checkUpdate(url: string): Promise<UpdateCheckResult> {
  const current = currentVersion()
  const manifest = await fetchManifest(url)
  const hasUpdate = compareSemver(manifest.latestVersion, current) > 0
  return {
    currentVersion: current,
    latestVersion: manifest.latestVersion,
    hasUpdate,
    releaseNotes: manifest.releaseNotes,
    manifest,
    installerUpdate: installerUpdateAvailable(manifest, current),
  }
}

/** 下载文件到指定路径。 */
export async function downloadFile(fileUrl: string, dest: string): Promise<void> {
  const res = await fetch(fileUrl)
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
}

/** 计算文件 sha256（hex）。 */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 停止常驻服务（读 web.pid），失败不阻塞。 */
export function stopService(): boolean {
  const lockFile = join(homedir(), '.zhuxing-harness', 'web.pid')
  try {
    const raw = readFileSync(lockFile, 'utf-8').trim()
    const m = /^(\d+)\s+/.exec(raw)
    if (m) {
      try {
        process.kill(Number(m[1]), 'SIGTERM')
      } catch {
        /* 进程已不存在 */
      }
      try {
        rmSync(lockFile, { force: true })
      } catch {
        /* ignore */
      }
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/** 重启常驻服务（分离进程，独立于当前 CLI）。 */
export function restartService(root: string): void {
  const node = join(root, 'node', 'node.exe')
  const launcher = join(root, 'bin', 'web-launcher.mjs')
  if (!existsSync(node) || !existsSync(launcher)) return
  const child = spawn(node, [launcher], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * 归一化增量包条目路径并做目录边界校验（防 zip-slip）。
 * 绝对路径 / 盘符路径 / 折叠 `..` 后逃出安装根目录的条目一律判为越界，返回 null。
 * 只有全部条目都通过校验，才允许对该包做后续的停服务 / 备份 / 解压动作。
 */
function resolveEntryTarget(root: string, entryName: string): string | null {
  const rel = entryName.replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  const base = resolve(root)
  const target = resolve(base, rel)
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : base + sep)) return null
  return target
}

/**
 * 应用增量包到安装根目录：停服务 → 备份旧文件 → 解压覆盖 → 写 VERSION。
 * 增量包为 zip，根目录相对路径与安装目录一致。
 */
export function applyZipToRoot(zipPath: string, root: string): ApplyResult {
  const fromVersion = readVersionFromRoot(root)
  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().filter((e) => !e.isDirectory)

    const hasCli = entries.some((e) => e.entryName.replace(/\\/g, '/') === 'bin/harness.cjs')
    if (!hasCli) {
      return { ok: false, fromVersion, toVersion: '', error: '增量包缺少 bin/harness.cjs，不是有效的更新包' }
    }

    // 路径越界校验必须先于一切副作用（尤其是 stopService）：带 ../ 的恶意包不得先杀掉用户常驻服务。
    const targets = new Map<string, string>()
    for (const e of entries) {
      const target = resolveEntryTarget(root, e.entryName)
      if (!target) {
        return { ok: false, fromVersion, toVersion: '', error: `增量包含越界路径，已拒绝：${e.entryName}` }
      }
      targets.set(e.entryName, target)
    }

    // 停止服务，避免文件占用与竞态
    stopService()

    // 备份 zip 中将要覆盖的文件
    const backupDir = join(root, 'backups', fromVersion)
    mkdirSync(backupDir, { recursive: true })
    for (const e of entries) {
      const rel = e.entryName.replace(/\\/g, '/')
      const target = targets.get(e.entryName) as string
      if (existsSync(target)) {
        const b = join(backupDir, rel)
        mkdirSync(dirname(b), { recursive: true })
        copyFileSync(target, b)
      }
    }

    // 解压覆盖（条目已全部校验在安装根目录内，extractAllTo 不会再落到根目录之外）
    zip.extractAllTo(root, true)

    const toVersion = readVersionFromRoot(root)
    return { ok: true, fromVersion, toVersion, backedUpTo: backupDir }
  } catch (err) {
    return { ok: false, fromVersion, toVersion: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 读取安装根目录下的《本次内核变更说明》（更新包内 kernel-changelog.md 被解压到此处）。 */
function readChangelog(root: string): string {
  try {
    return readFileSync(join(root, 'kernel-changelog.md'), 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * 内核健康检查：动态 import 最新 kernel.mjs（带版本号破坏缓存）并执行 kernelSelfTest。
 * 用于更新后验证新内核可正常构建运行；失败时触发回滚。
 */
async function kernelHealthCheck(root: string, version: string): Promise<{ ok: boolean; detail: string }> {
  const kernelPath = join(root, 'bin', 'kernel.mjs')
  if (!existsSync(kernelPath)) return { ok: false, detail: '内核文件缺失' }
  const url = `${pathToFileURL(kernelPath).href}?v=${encodeURIComponent(`${version}#${Date.now()}`)}`
  try {
    const mod = (await import(url)) as { kernelSelfTest?: () => Promise<{ ok: boolean; detail: string }> }
    if (typeof mod.kernelSelfTest !== 'function') return { ok: false, detail: '内核缺少 kernelSelfTest（不是可热更新的内核模块）' }
    return await mod.kernelSelfTest()
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** 内核更新需覆盖的相对路径。 */
const KERNEL_FILES = ['bin/kernel.mjs', 'VERSION', 'kernel-changelog.md']

/**
 * 应用「内核热更新」：只替换 bin/kernel.mjs（含 VERSION、变更说明），**不停止服务**。
 * 常驻外壳通过下次指令前的 maybeReload() 动态加载新内核，进程不重启即生效。
 * 更新后立即健康检查新内核：自检失败则从 backups/<fromVersion> 恢复，并写入「更新失败，已安全回滚」状态。
 */
export async function applyKernelUpdate(zipPath: string, root: string): Promise<ApplyResult> {
  const fromVersion = readVersionFromRoot(root)
  const backupDir = join(root, 'backups', fromVersion)
  try {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().filter((e) => !e.isDirectory)
    const hasKernel = entries.some((e) => e.entryName.replace(/\\/g, '/') === 'bin/kernel.mjs')
    if (!hasKernel) {
      return { ok: false, fromVersion, toVersion: '', error: '增量包缺少 bin/kernel.mjs，不是有效的内核更新包' }
    }

    // 备份将被覆盖的内核相关文件
    mkdirSync(backupDir, { recursive: true })
    for (const rel of KERNEL_FILES) {
      const target = join(root, rel)
      if (existsSync(target)) {
        const b = join(backupDir, rel)
        mkdirSync(dirname(b), { recursive: true })
        copyFileSync(target, b)
      }
    }

    // 只解压内核相关文件（不动外壳 harness.cjs / web-launcher，热更新不息服）
    for (const e of entries) {
      const rel = e.entryName.replace(/\\/g, '/')
      if (KERNEL_FILES.includes(rel)) zip.extractEntryTo(e.entryName, root, true, true)
    }

    const toVersion = readVersionFromRoot(root)

    // 健康检查：新内核能构建运行 → 成功；否则回滚到上一稳定版本
    const health = await kernelHealthCheck(root, toVersion)
    if (health.ok) {
      writeUpdateStatus(root, {
        status: 'success',
        fromVersion,
        toVersion,
        message: `内核更新完成：${fromVersion} → ${toVersion}`,
        changelog: readChangelog(root),
        appliedAt: Date.now(),
      })
      return { ok: true, fromVersion, toVersion, backedUpTo: backupDir }
    }

    // 回滚：恢复内核相关文件到上一稳定版本
    for (const rel of KERNEL_FILES) {
      const b = join(backupDir, rel)
      const target = join(root, rel)
      if (existsSync(b)) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(b, target)
      }
    }
    writeUpdateStatus(root, {
      status: 'rolled-back',
      fromVersion,
      toVersion: fromVersion,
      message: '更新失败，已安全回滚',
      changelog: health.detail,
      appliedAt: Date.now(),
    })
    return { ok: false, fromVersion, toVersion: fromVersion, backedUpTo: backupDir, error: `内核自检失败，已回滚：${health.detail}` }
  } catch (err) {
    writeUpdateStatus(root, {
      status: 'failed',
      fromVersion,
      toVersion: '',
      message: '更新失败，已安全回滚',
      appliedAt: Date.now(),
    })
    return { ok: false, fromVersion, toVersion: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 智能应用更新包：
 * - 仅含 bin/kernel.mjs（无 harness.cjs）→ 内核热更新（不停服，外壳下次指令自动加载新内核）；
 * - 含 harness.cjs（外壳/完整更新）→ 传统冷更新（停服 → 备份 → 覆盖 → 重启）。
 */
export async function applyUpdateToRoot(zipPath: string, root: string): Promise<ApplyResult> {
  const zip = new AdmZip(zipPath)
  const names = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/'))
  const hasKernel = names.includes('bin/kernel.mjs')
  const hasCli = names.includes('bin/harness.cjs')
  if (hasKernel && !hasCli) return await applyKernelUpdate(zipPath, root)
  const result = applyZipToRoot(zipPath, root)
  if (result.ok) restartService(root)
  return result
}

/** 手动安装本地增量包（--file 路径）。 */
export async function applyLocalZip(zipPath: string): Promise<ApplyResult> {
  const root = installRoot()
  if (!root) {
    return { ok: false, fromVersion: currentVersion(), toVersion: '', error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' }
  }
  if (!existsSync(zipPath)) {
    return { ok: false, fromVersion: readVersionFromRoot(root), toVersion: '', error: `增量包不存在：${zipPath}` }
  }
  return await applyUpdateToRoot(zipPath, root)
}

/** 完整远程更新：检查 → 下载 → 校验 → 应用。 */
export async function applyRemoteUpdate(url: string): Promise<ApplyResult> {
  const root = installRoot()
  if (!root) {
    return { ok: false, fromVersion: currentVersion(), toVersion: '', error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' }
  }
  const check = await checkUpdate(url)
  if (!check.hasUpdate) {
    return { ok: true, fromVersion: check.currentVersion, toVersion: check.currentVersion }
  }
  const manifest = check.manifest!
  const base = url.endsWith('/') ? url : `${url}/`
  const fileUrl = `${base}${manifest.updateFile}`

  const dest = join(mkdtempSync(join(tmpdir(), 'harness-update-')), basename(manifest.updateFile))
  try {
    await downloadFile(fileUrl, dest)
    const actual = sha256File(dest)
    if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
      return { ok: false, fromVersion: check.currentVersion, toVersion: '', error: `增量包校验失败（sha256 不匹配）` }
    }
    return await applyUpdateToRoot(dest, root)
  } finally {
    try {
      rmSync(dest, { force: true })
    } catch {
      /* ignore */
    }
  }
}
