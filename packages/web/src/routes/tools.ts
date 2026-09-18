import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from '../http.js'
import type { RouteContext } from './context.js'

// ===== 工具管理（复用常驻运行时，不再每请求创建 Harness）=====

/** 工具清单与单工具试跑。 */
export async function handleToolRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'GET' && path === '/api/tools') {
    const r = ctx.runtime.get()
    const list = r.tools.list().map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
    json(res, 200, { tools: list })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/tools/') && path.endsWith('/test')) {
    const name = decodeURIComponent(path.slice('/api/tools/'.length, -'/test'.length))
    const body = (await readJsonBody(req)) as { args?: Record<string, unknown> }
    const r = ctx.runtime.get()
    const result = await r.tools.execute(name, body.args ?? {}, {
      emit: (event, payload) => r.app.events.emit(event, payload),
    })
    json(res, 200, { result })
    return true
  }
  return false
}
