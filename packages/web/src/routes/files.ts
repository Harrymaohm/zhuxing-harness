import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { DEFAULT_PERMISSION_LEVEL, RESTRICTED_PERMISSION_LEVELS } from '@zhuxing/harness-sandbox'
import { json, readJsonBody } from '../http.js'
import { loadWebConfig } from '../config-store.js'
import { resolveWorkspace } from '../runtime.js'
import type { RouteContext } from './context.js'

/** 文件预览（工作区内受限）与拖拽上传落盘。 */
export async function handleFileRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  const url = ctx.url
  if (req.method === 'GET' && path === '/api/files/preview') {
    const requested = url.searchParams.get('path')
    if (!requested) {
      json(res, 400, { error: '缺少文件路径' })
      return true
    }
    const cfg = loadWebConfig()
    const workspaceRoot = resolveWorkspace(cfg.workspace)
    const filePath = resolve(workspaceRoot, requested)
    // 文件预览范围由沙箱级别决定：默认（受限级别）只允许预览工作区内文件；
    // 只有在配置里显式选择完全放开档时才允许任意本地文件，避免默认配置下把整机文件暴露给前端。
    const level = cfg.level ?? DEFAULT_PERMISSION_LEVEL
    const unrestricted = !RESTRICTED_PERMISSION_LEVELS.includes(level)
    if (
      !unrestricted &&
      filePath !== workspaceRoot &&
      !filePath.startsWith(`${workspaceRoot}${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      json(res, 403, { error: '只能预览工作区内的文件' })
      return true
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      json(res, 404, { error: '文件不存在' })
      return true
    }
    const stat = statSync(filePath)
    // raw=1：按 MIME 流式返回原始二进制（PDF 等二进制文件，避免 utf-8 乱码）
    if (url.searchParams.get('raw') === '1') {
      if (stat.size > 20 * 1024 * 1024) {
        json(res, 413, { error: '文件过大（上限 20 MB）' })
        return true
      }
      const mime = (extname(filePath).toLowerCase()) === '.pdf' ? 'application/pdf' : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
      res.end(readFileSync(filePath))
      return true
    }
    if (stat.size > 2 * 1024 * 1024) {
      json(res, 413, { error: '文件过大，暂不支持预览（上限 2 MB）' })
      return true
    }
    const content = readFileSync(filePath, 'utf-8')
    json(res, 200, { path: requested, content, size: stat.size })
    return true
  }
  // 拖拽文件/文件夹：浏览器拿不到本地绝对路径时，上传内容到临时 drops 目录生成链接
  if (req.method === 'POST' && path === '/api/files/upload') {
    const body = (await readJsonBody(req)) as { name?: string; data?: string }
    if (!body.name || typeof body.data !== 'string') {
      json(res, 400, { error: '缺少文件名或内容' })
      return true
    }
    let buf: Buffer
    try {
      buf = Buffer.from(body.data, 'base64')
    } catch {
      json(res, 400, { error: '内容不是有效的 base64' })
      return true
    }
    if (buf.length > 50 * 1024 * 1024) {
      json(res, 413, { error: '文件过大（上限 50 MB）' })
      return true
    }
    const dropDir = join(homedir(), '.zhuxing-harness', 'drops')
    mkdirSync(dropDir, { recursive: true })
    const safe = body.name.replace(/[\\/:*?"<>|]/g, '_')
    const target = join(dropDir, `${Date.now()}-${safe}`)
    writeFileSync(target, buf)
    json(res, 200, { ok: true, path: target })
    return true
  }
  return false
}
