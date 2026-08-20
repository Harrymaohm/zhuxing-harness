import { describe, expect, it } from 'vitest'
import { MemorySessionStore, SessionImpl } from '../src/index.js'

describe('会话事件日志', () => {
  it('追加与回放（append-only）', async () => {
    const store = new MemorySessionStore()
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    const evt1 = await session.append('user', 'test', { content: 'hi' })
    await session.append('assistant', 'test', { content: 'hello' })
    const events = await session.events()
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('user')
    expect(events[0].source).toBe('test')
    expect(evt1.id).toBeTruthy()
  })

  it('fork 继承历史且相互独立', async () => {
    const store = new MemorySessionStore()
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 'test', { content: 'hi' })

    const fork = await session.fork()
    expect(fork.id).not.toBe(id)
    expect(await fork.events()).toHaveLength(1)

    await fork.append('user', 'test', { content: 'more' })
    expect(await session.events()).toHaveLength(1)
    expect(await fork.events()).toHaveLength(2)
  })

  it('SessionService 创建与获取', async () => {
    const store = new MemorySessionStore()
    const service = new (await import('../src/index.js')).DefaultSessionService(store)
    const session = await service.create()
    await session.append('system', 'test', { msg: 'boot' })
    const got = await service.get(session.id)
    expect(await got.events()).toHaveLength(1)
  })
})
