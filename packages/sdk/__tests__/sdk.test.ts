import { describe, expect, it } from 'vitest'
import { createOpenAIProvider, defineTool } from '../src/index.js'

describe('SDK DSL', () => {
  it('defineTool 原样返回定义', () => {
    const t = defineTool({ name: 'x', description: 'X', schema: {}, execute: () => ({ text: 'ok' }) })
    expect(t.name).toBe('x')
    expect(t.description).toBe('X')
  })

  it('createOpenAIProvider 构造模型适配器', () => {
    const provider = createOpenAIProvider({ apiKey: 'k', model: 'deepseek-chat' })
    expect(provider.name).toContain('deepseek-chat')
    expect(typeof provider.chat).toBe('function')
  })

  it('统一导出 kernel 能力类型', async () => {
    const mod = await import('../src/index.js')
    expect(mod.createHarness).toBeTypeOf('function')
    expect(mod.AgentLoop).toBeTypeOf('function')
    expect(mod.ToolRegistryImpl).toBeTypeOf('function')
    expect(mod.createSandbox).toBeTypeOf('function')
    expect(mod.MemorySessionStore).toBeTypeOf('function')
  })
})
