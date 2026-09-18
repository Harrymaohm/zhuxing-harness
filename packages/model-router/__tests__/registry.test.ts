import { describe, expect, it } from 'vitest'
import { ModelRegistryImpl } from '../src/registry.js'
import type { ChatProvider } from '@zhuxing/harness-llm'

function fakeProvider(id: string): ChatProvider {
  return {
    name: `fake:${id}`,
    chat: async () => ({ content: id, toolCalls: [], finishReason: 'stop' }),
  }
}

describe('模型注册表（热插拔）', () => {
  it('注册 / 查询 / 列出', () => {
    const registry = new ModelRegistryImpl()
    registry.register({ id: 'fast', capabilities: ['fast'] }, fakeProvider('fast'))
    registry.register({ id: 'reasoner', capabilities: ['reasoning'] }, fakeProvider('reasoner'))

    expect(registry.has('fast')).toBe(true)
    expect(registry.get('fast')?.spec.capabilities).toEqual(['fast'])
    expect(registry.list().map((m) => m.spec.id)).toEqual(['fast', 'reasoner'])
  })

  it('同一 id 禁止重复注册', () => {
    const registry = new ModelRegistryImpl()
    registry.register({ id: 'm' }, fakeProvider('m'))
    expect(() => registry.register({ id: 'm' }, fakeProvider('m2'))).toThrow(/已注册/)
  })

  it('注册返回注销函数（disposer），调用后模型移除', () => {
    const registry = new ModelRegistryImpl()
    const disposer = registry.register({ id: 'm' }, fakeProvider('m'))
    expect(registry.has('m')).toBe(true)
    disposer()
    expect(registry.has('m')).toBe(false)
    // disposer 幂等
    disposer()
  })

  it('未注册默认 capabilities 为 general', () => {
    const registry = new ModelRegistryImpl()
    registry.register({ id: 'plain' }, fakeProvider('plain'))
    expect(registry.get('plain')?.spec.capabilities).toEqual(['general'])
  })

  it('空 capabilities 列表也归一化为 general', () => {
    const registry = new ModelRegistryImpl()
    registry.register({ id: 'empty', capabilities: [] }, fakeProvider('empty'))
    expect(registry.get('empty')?.spec.capabilities).toEqual(['general'])
  })
})
