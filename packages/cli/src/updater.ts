import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  releaseNotes?: string
  manifest?: UpdateManifest
}

export interface ApplyResult {
  ok: boolean
  fromVersion: string
  toVersion: string
  backedUpTo?: string
  error?: string
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

    // 停止服务，避免文件占用与竞态
    stopService()

    // 备份 zip 中将要覆盖的文件
    const backupDir = join(root, 'backups', fromVersion)
    mkdirSync(backupDir, { recursive: true })
    for (const e of entries) {
      const rel = e.entryName.replace(/\\/g, '/')
      const target = join(root, rel)
      if (existsSync(target)) {
        const b = join(backupDir, rel)
        mkdirSync(dirname(b), { recursive: true })
        copyFileSync(target, b)
      }
    }

    // 解压覆盖
    zip.extractAllTo(root, true)

    const toVersion = readVersionFromRoot(root)
    return { ok: true, fromVersion, toVersion, backedUpTo: backupDir }
  } catch (err) {
    return { ok: false, fromVersion, toVersion: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 手动安装本地增量包（--file 路径）。 */
export function applyLocalZip(zipPath: string): ApplyResult {
  const root = installRoot()
  if (!root) {
    return { ok: false, fromVersion: currentVersion(), toVersion: '', error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' }
  }
  if (!existsSync(zipPath)) {
    return { ok: false, fromVersion: readVersionFromRoot(root), toVersion: '', error: `增量包不存在：${zipPath}` }
  }
  const result = applyZipToRoot(zipPath, root)
  // 手动更新同样在应用成功后重启常驻服务
  if (result.ok) restartService(root)
  return result
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
    const result = applyZipToRoot(dest, root)
    // 更新成功后重启服务
    if (result.ok) restartService(root)
    return result
  } finally {
    try {
      rmSync(dest, { force: true })
    } catch {
      /* ignore */
    }
  }
}
