import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileSessionStore } from '../src/index.js'
import { DefaultSessionService, SessionImpl } from '../src/index.js'

describe('文件会话存储（JSONL 持久化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zhuxing-file-store-'))

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })

  it('create / append / list 往返', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 't', { x: 1 })
    await session.append('assistant', 't', { x: 2 })
    const events = await store.list(id)
    expect(events).toHaveLength(2)
    expect(events[0].payload).toEqual({ x: 1 })
  })

  it('fork 继承历史且独立', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 't', { x: 1 })
    const fork = await session.fork()
    expect(fork.id).not.toBe(id)
    expect(await fork.events()).toHaveLength(1)
    await fork.append('user', 't', { x: 2 })
    expect(await session.events()).toHaveLength(1)
    expect(await fork.events()).toHaveLength(2)
  })

  it('listSessions / remove', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    await store.append({ id: 'e1', sessionId: id, ts: Date.now(), type: 'user', source: 't', payload: {} })
    expect((await store.listSessions()).length).toBeGreaterThan(0)
    await store.remove(id)
    expect(await store.list(id)).toHaveLength(0)
  })

  it('SessionService.listSessions 委托文件存储', async () => {
    const store = new FileSessionStore(dir)
    const service = new DefaultSessionService(store)
    await service.create()
    const ids = await service.listSessions()
    expect(Array.isArray(ids)).toBe(true)
  })
})
