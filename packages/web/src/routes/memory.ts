import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryScope } from '@zhuxing/harness-memory'
import { json, readJsonBody } from '../http.js'
import type { RouteContext } from './context.js'

/** 记忆管理：列表 / 新增 / 删除 / 清空。 */
export async function handleMemoryRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  const url = ctx.url
  // ===== 记忆管理 =====
  if (req.method === 'GET' && path === '/api/memory') {
    const store = ctx.runtime.get().memoryStore
    const scope = url.searchParams.get('scope') as MemoryScope | null
    const q = url.searchParams.get('q') ?? undefined
    const entries = await store.list({ scope: scope ?? undefined, q })
    json(res, 200, { entries })
    return true
  }
  if (req.method === 'POST' && path === '/api/memory') {
    const body = (await readJsonBody(req)) as { content?: string; scope?: string; tags?: string[]; workspace?: string }
    const content = (body.content ?? '').trim()
    if (!content) {
      json(res, 400, { error: '缺少 content' })
      return true
    }
    const store = ctx.runtime.get().memoryStore
    const entry = await store.add({
      scope: (body.scope as MemoryScope) ?? 'auto',
      content,
      tags: Array.isArray(body.tags) ? body.tags : undefined,
      workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
    })
    json(res, 200, { entry })
    return true
  }
  if (req.method === 'DELETE' && path.startsWith('/api/memory/')) {
    const id = decodeURIComponent(path.slice('/api/memory/'.length))
    const store = ctx.runtime.get().memoryStore
    const ok = await store.remove(id)
    json(res, ok ? 200 : 404, { ok })
    return true
  }
  if (req.method === 'POST' && path === '/api/memory/clear') {
    const body = (await readJsonBody(req)) as { scope?: string }
    const store = ctx.runtime.get().memoryStore
    const scope = (body.scope as MemoryScope) ?? undefined
    const n = await store.clear(scope)
    json(res, 200, { cleared: n })
    return true
  }
  return false
}
