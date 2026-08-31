import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileMemoryStore } from '../src/file-store.js'
import type { MemoryEntry } from '../src/types.js'

let path: string
let counter = 0

function newStore(): { store: FileMemoryStore; path: string } {
  path = join(tmpdir(), `harness-mem-test-${Date.now()}-${counter++}.json`)
  return { store: new FileMemoryStore(path), path }
}

describe('FileMemoryStore', () => {
  beforeEach(() => {
    newStore()
  })
  afterEach(() => {
    try {
      rmSync(path, { force: true })
    } catch {
      // ignore
    }
  })

  it('add + get + list 基础 CRUD', async () => {
    const { store } = newStore()
    const entry = await store.add({ scope: 'user', content: '偏好 TypeScript', tags: ['code-style'] })
    expect(entry.id).toBeTruthy()
    expect(entry.scope).toBe('user')
    expect(entry.content).toBe('偏好 TypeScript')

    const got = await store.get(entry.id)
    expect(got?.content).toBe('偏好 TypeScript')

    const list = await store.list()
    expect(list).toHaveLength(1)
  })

  it('按 scope 过滤', async () => {
    const { store } = newStore()
    await store.add({ scope: 'user', content: '用户偏好' })
    await store.add({ scope: 'project', content: '项目上下文', workspace: '/repo' })
    await store.add({ scope: 'auto', content: '自动学习' })

    expect(await store.list({ scope: 'user' })).toHaveLength(1)
    expect(await store.list({ scope: 'project' })).toHaveLength(1)
    expect(await store.list({ scope: 'auto' })).toHaveLength(1)
  })

  it('按 tags 交集过滤', async () => {
    const { store } = newStore()
    await store.add({ scope: 'user', content: 'A', tags: ['code-style', 'tech-stack'] })
    await store.add({ scope: 'user', content: 'B', tags: ['decision'] })

    expect(await store.list({ tags: ['code-style'] })).toHaveLength(1)
    expect(await store.list({ tags: ['decision'] })).toHaveLength(1)
    expect(await store.list({ tags: ['nonexistent'] })).toHaveLength(0)
  })

  it('按 q 模糊搜索 content 与 tags', async () => {
    const { store } = newStore()
    await store.add({ scope: 'user', content: '使用 pnpm 管理依赖', tags: ['tech-stack'] })
    await store.add({ scope: 'user', content: '偏好深色主题', tags: ['ui'] })

    expect(await store.list({ q: 'pnpm' })).toHaveLength(1)
    expect(await store.list({ q: 'tech-stack' })).toHaveLength(1) // tag 命中
    expect(await store.list({ q: '不存在' })).toHaveLength(0)
  })

  it('按 workspace 过滤 project 记忆', async () => {
    const { store } = newStore()
    await store.add({ scope: 'project', content: '项目 A 上下文', workspace: '/repo-a' })
    await store.add({ scope: 'project', content: '项目 B 上下文', workspace: '/repo-b' })
    await store.add({ scope: 'project', content: '全局项目记忆' }) // 无 workspace

    expect(await store.list({ workspace: '/repo-a' })).toHaveLength(2) // /repo-a + 无 workspace
  })

  it('update 修改记忆', async () => {
    const { store } = newStore()
    const entry = await store.add({ scope: 'user', content: '旧内容' })
    const updated = await store.update(entry.id, { content: '新内容' })
    expect(updated?.content).toBe('新内容')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(entry.updatedAt)
    expect(updated?.id).toBe(entry.id)
    expect(updated?.createdAt).toBe(entry.createdAt)
  })

  it('remove 删除记忆', async () => {
    const { store } = newStore()
    const entry = await store.add({ scope: 'user', content: '待删除' })
    expect(await store.remove(entry.id)).toBe(true)
    expect(await store.get(entry.id)).toBeUndefined()
    expect(await store.remove('不存在')).toBe(false)
  })

  it('clear 清空全部与按 scope', async () => {
    const { store } = newStore()
    await store.add({ scope: 'user', content: 'A' })
    await store.add({ scope: 'auto', content: 'B' })
    await store.add({ scope: 'auto', content: 'C' })

    expect(await store.clear('auto')).toBe(2)
    expect(await store.list()).toHaveLength(1)

    expect(await store.clear()).toBe(1)
    expect(await store.list()).toHaveLength(0)
  })

  it('空文件与损坏文件容错', async () => {
    const { store, path: p } = newStore()
    // 空文件
    const { writeFileSync } = await import('node:fs')
    writeFileSync(p, '', 'utf-8')
    expect(await store.list()).toEqual([])

    // 损坏 JSON
    writeFileSync(p, '{ broken', 'utf-8')
    expect(await store.list()).toEqual([])
  })
})
