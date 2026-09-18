import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { json } from '../http.js'
import { VERSION } from '../version.js'
import type { RouteContext } from './context.js'

/** 元信息与站点图标：SPA 引导（bootstrap）、健康检查、favicon。 */
export async function handleCoreRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'GET' && path === '/api/bootstrap') {
    json(res, 200, { token: ctx.accessToken || undefined, version: VERSION })
    return true
  }
  if (req.method === 'GET' && path === '/api/health') {
    const r = ctx.runtime.get()
    json(res, 200, {
      ok: true,
      version: VERSION,
      uptimeMs: Date.now() - ctx.runtime.startedAt,
      configFingerprint: ctx.runtime.fingerprint,
      listenerCount: r.app.events.listenerCount,
    })
    return true
  }
  if (req.method === 'GET' && path === '/harness.ico') {
    const iconPath = process.env.HARNESS_ICON_PATH ?? fileURLToPath(new URL('../../../../kk6zc-wyj96-001.ico', import.meta.url))
    if (!existsSync(iconPath)) {
      json(res, 404, { error: '图标不存在' })
      return true
    }
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' })
    res.end(readFileSync(iconPath))
    return true
  }
  return false
}
