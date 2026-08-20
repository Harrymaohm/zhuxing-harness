import { describe, expect, it } from 'vitest'
import { MemorySessionStore, SessionImpl } from '../src/index.js'

describe('会话事件修剪（资源控制）', () => {
  it('maxEventsPerSession 超出时修剪最旧事件', async () => {
    const store = new MemorySessionStore(3)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    for (let i = 1; i <= 5; i++) {
      await session.append('user', 't', { i })
    }
    const events = await session.events()
    expect(events).toHaveLength(3)
    // 保留的是最新的 3 条（i=3,4,5）
    expect((events[0].payload as { i: number }).i).toBe(3)
    expect((events[2].payload as { i: number }).i).toBe(5)
  })

  it('默认不限制（append-only 铁律）', async () => {
    const store = new MemorySessionStore()
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    for (let i = 0; i < 100; i++) {
      await session.append('user', 't', { i })
    }
    expect(await session.events()).toHaveLength(100)
  })
})
