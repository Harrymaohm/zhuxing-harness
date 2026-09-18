import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { json } from './http.js'
import type { StaticAssets } from './http.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** Web UI 静态目录默认解析：源码态为包内 dist-ui；安装态可用 HARNESS_WEB_UI_DIR 覆盖。 */
export function defaultUiDir(): string {
  const fromEnv = process.env.HARNESS_WEB_UI_DIR
  if (fromEnv) return resolve(fromEnv)
  try {
    return resolve(fileURLToPath(new URL('../dist-ui', import.meta.url)))
  } catch {
    return resolve(process.cwd(), 'dist-ui')
  }
}

/** API 是否免认证（SPA 入口 / 静态资源 / health / bootstrap 放行；token 只保护 API）。 */
export function isPublicPath(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/api/health' || path === '/api/bootstrap' || path === '/harness.ico')) return true
  if (path.startsWith('/assets/')) return true
  return false
}

/** 启动时把 UI 静态资源读入内存（带 MIME 与内容哈希 ETag）。 */
export function loadStaticAssets(uiDir: string): StaticAssets {
  const assets: StaticAssets = new Map<string, { type: string; data: Buffer; etag: string }>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) {
        const data = readFileSync(full)
        assets.set(rel, {
          type: MIME[extname(full)] ?? 'application/octet-stream',
          data,
          etag: `"${createHash('sha1').update(data).digest('hex')}"`,
        })
      }
    }
  }
  if (existsSync(uiDir)) walk(uiDir, '')
  return assets
}

/** 简单 If-None-Match 校验。 */
export function reqIfNoneMatch(res: ServerResponse, etag: string): boolean {
  const header = res.req.headers['if-none-match']
  return typeof header === 'string' && header === etag
}

export async function serveStatic(res: ServerResponse, assets: StaticAssets, path: string): Promise<void> {
  const safePath = path === '/' ? 'index.html' : path.slice(1).replace(/^[/\\]+/, '')
  const asset = assets.get(safePath) ?? assets.get('index.html')
  if (!asset) {
    json(res, 404, { error: '未找到资源' })
    return
  }
  if (reqIfNoneMatch(res, asset.etag)) {
    res.writeHead(304, { ETag: asset.etag })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Cache-Control': safePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    ETag: asset.etag,
  })
  res.end(asset.data)
}
