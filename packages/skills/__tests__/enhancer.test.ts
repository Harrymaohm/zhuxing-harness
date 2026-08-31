import { describe, expect, it } from 'vitest'
import { buildSkillPrompt, MissingRequiredParameterError } from '../src/enhancer.js'
import type { SkillDefinition } from '../src/types.js'

const skill = (template: string, required: string[] = []): SkillDefinition => ({
  name: 'test',
  description: 'test',
  inputs: { type: 'object', properties: {}, required },
  template,
})

describe('buildSkillPrompt', () => {
  it('替换 {{param}}', () => {
    const s = skill('你好 {{name}}，今天 {{day}}', ['name', 'day'])
    const out = buildSkillPrompt(s, { name: '世界', day: '周一' })
    expect(out).toBe('你好 世界，今天 周一')
  })

  it('容忍空白 {{ param }}', () => {
    const s = skill('你好 {{ name }}')
    expect(buildSkillPrompt(s, { name: 'X' })).toBe('你好 X')
  })

  it('缺失必填抛错', () => {
    const s = skill('{{a}} {{b}}', ['a', 'b'])
    expect(() => buildSkillPrompt(s, { a: '1' })).toThrow(MissingRequiredParameterError)
    expect(() => buildSkillPrompt(s, { a: '1' })).toThrow(/b/)
  })

  it('缺失非必填不抛错', () => {
    const s = skill('{{a}} {{b}}', ['a'])
    expect(buildSkillPrompt(s, { a: '1' })).toBe('1 {{b}}')
  })

  it('空值参数视为缺失', () => {
    const s = skill('{{a}}', ['a'])
    expect(() => buildSkillPrompt(s, { a: '' })).toThrow(MissingRequiredParameterError)
  })
})
