import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { FileSkillStore } from '../src/file-store.js'
import type { SkillDefinition } from '../src/types.js'

let dir: string
let store: FileSkillStore

const sampleSkill = (): Omit<SkillDefinition, 'createdAt' | 'updatedAt'> => ({
  name: 'code-review',
  version: '0.1.0',
  description: '审查代码差异',
  icon: '🔍',
  category: 'dev',
  tags: ['code', 'review'],
  visibility: 'public',
  inputs: {
    type: 'object',
    properties: { diff: { type: 'string', description: '代码差异' } },
    required: ['diff'],
  },
  tools: ['read_file', 'shell'],
  template: '审查以下差异：\n{{diff}}',
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-skill-'))
  store = new FileSkillStore({ dirs: [dir] })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileSkillStore', () => {
  it('add + get', async () => {
    const added = await store.add(sampleSkill())
    expect(added.createdAt).toBeTypeOf('number')
    const got = await store.get('code-review')
    expect(got?.name).toBe('code-review')
    expect(got?.template).toContain('{{diff}}')
  })

  it('list 空目录返回 []', async () => {
    const list = await store.list()
    expect(list).toEqual([])
  })

  it('list + filter (category/tags/q)', async () => {
    await store.add(sampleSkill())
    await store.add({ ...sampleSkill(), name: 'doc-writer', category: 'writing', tags: ['doc'] })
    expect((await store.list()).length).toBe(2)
    expect((await store.list({ category: 'dev' })).length).toBe(1)
    expect((await store.list({ tags: ['doc'] })).length).toBe(1)
    expect((await store.list({ q: 'review' })).length).toBe(1)
  })

  it('update', async () => {
    await store.add(sampleSkill())
    const updated = await store.update('code-review', { description: '更新后的描述' })
    expect(updated?.description).toBe('更新后的描述')
    expect(updated?.updatedAt).not.toBe(updated?.createdAt)
  })

  it('remove', async () => {
    await store.add(sampleSkill())
    expect(await store.remove('code-review')).toBe(true)
    expect(await store.get('code-review')).toBeUndefined()
    expect(await store.remove('not-exist')).toBe(false)
  })

  it('多目录合并去重', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'harness-skill-'))
    const store2 = new FileSkillStore({ dirs: [dir, dir2] })
    await store2.add(sampleSkill())
    const list = await store2.list()
    expect(list.length).toBe(1)
    await rm(dir2, { recursive: true, force: true })
  })
})
