import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileSessionStore, SessionImpl } from '../src/index.js'

describe('会话元数据 / 分叉 / 合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zhuxing-meta-store-'))

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })

  it('rename 写入 meta 且不污染 JSONL 事件', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 't', { content: 'hello' })
    await store.rename(id, '我的标题')

    const meta = await store.getMeta(id)
    expect(meta?.title).toBe('我的标题')
    // 事件日志保持原样（append-only 铁律）
    const events = await store.list(id)
    expect((events[0].payload as { title?: string }).title).toBeUndefined()
  })

  it('forkSession 继承历史并记录 parentId', async () => {
    const store = new FileSessionStore(dir)
    const parent = await store.createSession()
    const session = new SessionImpl(store, parent)
    await session.append('user', 't', { content: 'a' })
    await session.append('assistant', 't', { content: 'b' })

    const childId = await store.forkSession(parent)
    const childEvents = await store.list(childId)
    expect(childEvents.map((e) => (e.payload as { content?: string }).content)).toEqual(['a', 'b'])
    const childMeta = await store.getMeta(childId)
    expect(childMeta?.parentId).toBe(parent)
  })

  it('forkSession 支持按 fork 点事件截断', async () => {
    const store = new FileSessionStore(dir)
    const parent = await store.createSession()
    const session = new SessionImpl(store, parent)
    const e1 = await session.append('user', 't', { content: 'a' })
    await session.append('assistant', 't', { content: 'b' })

    const childId = await store.forkSession(parent, e1.id)
    const childEvents = await store.list(childId)
    expect(childEvents.map((e) => (e.payload as { content?: string }).content)).toEqual(['a'])
  })

  it('mergeInto 把子会话回写父会话并追加结论', async () => {
    const store = new FileSessionStore(dir)
    const parent = await store.createSession()
    const child = await store.createSession()
    const pSession = new SessionImpl(store, parent)
    const cSession = new SessionImpl(store, child)
    await pSession.append('user', 't', { content: '父问题' })
    await cSession.append('user', 't', { content: '子探索' })
    await cSession.append('assistant', 't', { content: '子结论' })

    await store.mergeInto(parent, child, '最终结论：完成')

    const parentEvents = await store.list(parent)
    // 父问题 + 2 条回写 + 1 条合并结论
    expect(parentEvents).toHaveLength(4)
    const merged = parentEvents.find((e) => (e.payload as { mergedFrom?: string }).mergedFrom === child)
    expect(merged).toBeDefined()
    expect((merged?.payload as { content?: string }).content).toBe('最终结论：完成')
    expect(merged?.source).toBe('subsession')
    // 子会话保留（不删除）
    expect(await store.list(child)).toHaveLength(2)
  })

  it('listSessionsWithMeta 返回 meta（无 meta 文件时为 undefined）', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const withMeta = await store.listSessionsWithMeta()
    const row = withMeta.find((r) => r.id === id)
    expect(row).toBeDefined()
    expect(row?.meta).toBeUndefined()
    await store.rename(id, '命名')
    const after = await store.listSessionsWithMeta()
    expect(after.find((r) => r.id === id)?.meta?.title).toBe('命名')
  })
})
