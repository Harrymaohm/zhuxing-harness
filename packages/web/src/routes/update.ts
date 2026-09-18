import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, readJsonBody } from '../http.js'
import { VERSION } from '../version.js'
import { loadWebConfig } from '../config-store.js'
import type { WebConfig } from '../config-store.js'
import type { RouteContext } from './context.js'

// ============ 应用内更新 ============

/** 安装根目录（安装态由 harness.cmd 注入 HARNESS_ROOT；开发态为 null）。 */
function webInstallRoot(): string | null {
  return process.env.HARNESS_ROOT ?? null
}

/** 当前版本：优先读安装目录 VERSION，否则回退构建注入版本。 */
function webCurrentVersion(): string {
  const root = webInstallRoot()
  if (root) {
    try {
      const v = readFileSync(join(root, 'VERSION'), 'utf-8').trim()
      if (v) return v
    } catch {
      /* ignore */
    }
  }
  return VERSION
}

function compareSemverLocal(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function resolveUpdateUrl(cfg: WebConfig): string {
  return (process.env.HARNESS_UPDATE_URL ?? cfg.updateUrl ?? '').trim()
}

interface RemoteManifest {
  latestVersion: string
  releaseNotes?: string
}

async function fetchRemoteManifest(url: string): Promise<RemoteManifest> {
  const manifestUrl = url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`获取更新清单失败（HTTP ${res.status}）`)
  return (await res.json()) as RemoteManifest
}

/** 后台独立进程执行更新（避免自我更新停止当前服务）。 */
function spawnUpdate(root: string, extraArgs: string[]): void {
  const node = join(root, 'node', 'node.exe')
  const cli = join(root, 'bin', 'harness.cjs')
  const child = spawn(node, [cli, 'update', ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HARNESS_ROOT: root },
  })
  child.unref()
}

/** 更新检查 / 启动更新 / 安装增量包 / 查询更新状态。 */
export async function handleUpdateRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'GET' && path === '/api/update/check') {
    const cfg = loadWebConfig()
    const url = resolveUpdateUrl(cfg)
    const current = webCurrentVersion()
    if (!url) {
      json(res, 200, { currentVersion: current, latestVersion: '', hasUpdate: false, error: '未配置更新源' })
      return true
    }
    try {
      const manifest = await fetchRemoteManifest(url)
      json(res, 200, {
        currentVersion: current,
        latestVersion: manifest.latestVersion,
        hasUpdate: compareSemverLocal(manifest.latestVersion, current) > 0,
        releaseNotes: manifest.releaseNotes,
      })
    } catch (err) {
      json(res, 200, { currentVersion: current, latestVersion: '', hasUpdate: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }
  if (req.method === 'POST' && path === '/api/update') {
    const root = webInstallRoot()
    if (!root) {
      json(res, 400, { ok: false, error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' })
      return true
    }
    const url = resolveUpdateUrl(loadWebConfig())
    if (!url) {
      json(res, 400, { ok: false, error: '未配置更新源' })
      return true
    }
    spawnUpdate(root, ['--url', url])
    json(res, 200, { ok: true, message: '更新已在后台启动' })
    return true
  }
  if (req.method === 'POST' && path === '/api/update/install') {
    const root = webInstallRoot()
    if (!root) {
      json(res, 400, { ok: false, error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' })
      return true
    }
    const body = (await readJsonBody(req)) as { data?: string; name?: string }
    if (!body.data) {
      json(res, 400, { ok: false, error: '缺少增量包数据' })
      return true
    }
    const buf = Buffer.from(body.data, 'base64')
    const zipPath = join(tmpdir(), `harness-update-${Date.now()}-${body.name ?? 'update.zip'}`)
    writeFileSync(zipPath, buf)
    spawnUpdate(root, ['--file', zipPath])
    json(res, 200, { ok: true, message: '更新已在后台启动' })
    return true
  }
  if (req.method === 'GET' && path === '/api/update/status') {
    const root = webInstallRoot()
    if (!root) {
      json(res, 200, { status: null })
      return true
    }
    // 读取更新进程写入的状态：success / rolled-back / failed，含《本次内核变更说明》
    const p = join(root, 'update-status.json')
    // try 与 catch 都必然赋值，无需初值（初值在被读取前一定被覆盖）
    let status: unknown
    try {
      status = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null
    } catch {
      status = null
    }
    json(res, 200, { status })
    return true
  }
  return false
}
