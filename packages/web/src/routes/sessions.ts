import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from '../http.js'
import type { RouteContext } from './context.js'

/** 会话与知识空间：列表 / 归档 / 分叉 / 合并 / 重命名 / 删除，以及空间增删改查。 */
export async function handleSessionRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  const url = ctx.url
  if (req.method === 'GET' && path === '/api/sessions') {
    const store = ctx.runtime.get().sessionStore
    const ids = await store.listSessions()
    const spaceFilter = url.searchParams.get('spaceId') ?? undefined
    const archivedFilter = url.searchParams.get('archived')
    const sessions = []
    for (const id of ids) {
      const events = await store.list(id)
      // 零事件会话不进列表：会话 id 前置后，新会话在开跑前就已存在；
      // 若用户在写下第一条事件前就中断，会留下无内容的空壳记录。
      if (events.length === 0) continue
      const first = events[0]
      const meta = await store.getMeta(id)
      const archived = meta?.archived === true
      if (spaceFilter !== undefined && (meta?.spaceId ?? '') !== spaceFilter) continue
      if (archivedFilter === 'true' && !archived) continue
      if (archivedFilter === 'false' && archived) continue
      sessions.push({
        id,
        eventCount: events.length,
        createdAt: first ? first.ts : undefined,
        preview: first?.payload ? String((first.payload as { content?: string }).content ?? '').slice(0, 80) : '',
        title: meta?.title ?? (first?.payload && typeof first.payload === 'object' ? String((first.payload as { title?: string }).title ?? '') : ''),
        parentId: meta?.parentId,
        forkPointEventId: meta?.forkPointEventId,
        spaceId: meta?.spaceId,
        archived,
        archivedAt: meta?.archivedAt,
      })
    }
    sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    json(res, 200, { sessions })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/archive')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/archive'.length))
    const store = ctx.runtime.get().sessionStore
    await store.archiveSession(id)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/unarchive')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/unarchive'.length))
    const store = ctx.runtime.get().sessionStore
    await store.unarchiveSession(id)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && path === '/api/spaces') {
    const store = ctx.runtime.get().sessionStore
    const spaces = await store.listSpaces()
    const defaultCount = (await store.listSessionsWithMeta()).filter((s) => !s.meta?.spaceId).length
    json(res, 200, { spaces, defaultSpace: { id: '', title: '默认空间', sessionCount: defaultCount } })
    return true
  }
  if (req.method === 'POST' && path === '/api/spaces') {
    const body = (await readJsonBody(req)) as { title?: string }
    const store = ctx.runtime.get().sessionStore
    const space = await store.createSpace(body.title ?? '')
    json(res, 200, { ok: true, space })
    return true
  }
  if (req.method === 'PATCH' && path.startsWith('/api/spaces/')) {
    const id = decodeURIComponent(path.slice('/api/spaces/'.length))
    const body = (await readJsonBody(req)) as { title?: string }
    const store = ctx.runtime.get().sessionStore
    await store.renameSpace(id, body.title ?? '')
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'DELETE' && path.startsWith('/api/spaces/')) {
    const id = decodeURIComponent(path.slice('/api/spaces/'.length))
    if (!id) {
      json(res, 400, { error: '默认空间不可删除' })
      return true
    }
    const store = ctx.runtime.get().sessionStore
    await store.removeSpace(id)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/fork')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/fork'.length))
    const body = (await readJsonBody(req)) as { eventId?: string }
    const store = ctx.runtime.get().sessionStore
    const childId = await store.forkSession(id, body.eventId)
    json(res, 200, { ok: true, sessionId: childId })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/merge')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/merge'.length))
    const body = (await readJsonBody(req)) as { childId?: string; summary?: string }
    if (!body.childId) {
      json(res, 400, { error: '缺少 childId' })
      return true
    }
    const store = ctx.runtime.get().sessionStore
    await store.mergeInto(id, body.childId, body.summary)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'DELETE' && path.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length))
    const store = ctx.runtime.get().sessionStore
    await store.remove(id)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'PATCH' && path.startsWith('/api/sessions/') && !path.endsWith('/events')) {
    const id = decodeURIComponent(path.slice('/api/sessions/'.length))
    const body = (await readJsonBody(req)) as { title?: string }
    const title = String(body.title ?? '').trim().slice(0, 120)
    if (!title) {
      json(res, 400, { error: '会话标题不能为空' })
      return true
    }
    const store = ctx.runtime.get().sessionStore
    await store.rename(id, title)
    json(res, 200, { ok: true })
    return true
  }
  if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.endsWith('/events')) {
    const id = path.slice('/api/sessions/'.length, -'/events'.length)
    const store = ctx.runtime.get().sessionStore
    const events = await store.list(id)
    json(res, 200, { sessionId: id, events })
    return true
  }
  return false
}
