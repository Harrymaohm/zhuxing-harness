import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileMemoryStore } from '../src/file-store.js'
import { buildMemoryPrompt } from '../src/enhancer.js'

let path: string
let counter = 0

function setup(): { store: FileMemoryStore; enhancer: ReturnType<typeof buildMemoryPrompt> } {
  path = join(tmpdir(), `harness-enh-test-${Date.now()}-${counter++}.json`)
  const store = new FileMemoryStore(path)
  return { store, enhancer: buildMemoryPrompt(store) }
}

describe('buildMemoryPrompt', () => {
  afterEach(() => {
    try {
      rmSync(path, { force: true })
    } catch {
      // ignore
    }
  })

  it('无记忆时返回原 base', async () => {
    const { enhancer } = setup()
    const result = await enhancer('You are a helpful agent.', '你好')
    expect(result).toBe('You are a helpful agent.')
  })

  it('追加记忆不替换原 prompt', async () => {
    const { store, enhancer } = setup()
    await store.add({ scope: 'user', content: '偏好 TypeScript', tags: ['code-style'] })
    await store.add({ scope: 'project', content: '使用 pnpm', workspace: '/repo' })

    const result = await enhancer('You are a helpful agent.', '写代码')
    expect(result).toContain('You are a helpful agent.')
    expect(result).toContain('# Memory')
    expect(result).toContain('[user]')
    expect(result).toContain('偏好 TypeScript')
    expect(result).toContain('[project]')
    expect(result).toContain('使用 pnpm')
  })

  it('按 user > project > auto 排序', async () => {
    const { store, enhancer } = setup()
    await store.add({ scope: 'auto', content: 'auto记忆' })
    await store.add({ scope: 'project', content: 'project记忆' })
    await store.add({ scope: 'user', content: 'user记忆' })

    const result = await enhancer('base', 'input')
    const userIdx = result.indexOf('[user]')
    const projectIdx = result.indexOf('[project]')
    const autoIdx = result.indexOf('[auto]')
    expect(userIdx).toBeLessThan(projectIdx)
    expect(projectIdx).toBeLessThan(autoIdx)
  })

  it('project 记忆按 workspace 过滤', async () => {
    const { store } = setup()
    const enhancer = buildMemoryPrompt(store, '/repo-a')
    await store.add({ scope: 'project', content: '项目A记忆', workspace: '/repo-a' })
    await store.add({ scope: 'project', content: '项目B记忆', workspace: '/repo-b' })
    await store.add({ scope: 'user', content: '用户偏好' })

    const result = await enhancer('base', 'input')
    expect(result).toContain('项目A记忆')
    expect(result).toContain('用户偏好')
    expect(result).not.toContain('项目B记忆')
  })

  it('4KB 截断', async () => {
    const { store, enhancer } = setup()
    // 添加大量记忆超过 4KB
    for (let i = 0; i < 100; i++) {
      await store.add({ scope: 'user', content: `记忆条目 ${i} `.repeat(20) })
    }
    const result = await enhancer('base', 'input')
    expect(result.length).toBeLessThan(4500) // base + 4KB + 少量格式
    expect(result).toContain('# Memory')
  })
})
