import { describe, expect, it } from 'vitest'
import { SkillRegistryImpl } from '../src/registry.js'
import type { SkillDefinition } from '../src/types.js'

const sampleSkill = (): SkillDefinition => ({
  name: 'code-review',
  description: '审查代码差异',
  inputs: {
    type: 'object',
    properties: { diff: { type: 'string' } },
    required: ['diff'],
  },
  tools: ['read_file', 'shell'],
  template: '审查：\n{{diff}}',
})

describe('SkillRegistryImpl', () => {
  it('register + get + list', () => {
    const reg = new SkillRegistryImpl()
    const dispose = reg.register(sampleSkill())
    expect(reg.get('code-review')?.name).toBe('code-review')
    expect(reg.list().length).toBe(1)
    dispose()
    expect(reg.get('code-review')).toBeUndefined()
  })

  it('run 渲染并返回 tools', async () => {
    const reg = new SkillRegistryImpl()
    reg.register(sampleSkill())
    const result = await reg.run('code-review', { diff: '+ new code' })
    expect(result.prompt).toContain('+ new code')
    expect(result.tools).toEqual(['read_file', 'shell'])
  })

  it('run 未找到抛错', async () => {
    const reg = new SkillRegistryImpl()
    await expect(reg.run('not-exist', {})).rejects.toThrow(/未找到/)
  })

  it('run 缺参抛错', async () => {
    const reg = new SkillRegistryImpl()
    reg.register(sampleSkill())
    await expect(reg.run('code-review', {})).rejects.toThrow(/diff/)
  })
})
