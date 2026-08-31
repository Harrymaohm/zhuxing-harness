import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import { AgentLoop } from '../src/index.js'

function makeFakeProvider(script: Array<Pick<ChatResult, 'content' | 'toolCalls' | 'finishReason'>>): ChatProvider & { calls: number } {
  let calls = 0
  return {
    name: 'fake',
    get calls() {
      return calls
    },
    async chat(_messages: ChatMessage[]): Promise<ChatResult> {
      const step = script[Math.min(calls, script.length - 1)]
      calls++
      return { content: step.content, toolCalls: step.toolCalls, finishReason: step.finishReason }
    },
  }
}

describe('Agent 循环', () => {
  it('工具编排闭环：调用工具后正常收尾', async () => {
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'hello',
      description: '打招呼',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: (args) => ({ text: `你好，${String(args.name)}` }),
    })

    const store = new MemorySessionStore()
    const sessionId = await store.createSession()
    const session = new SessionImpl(store, sessionId)

    const provider = makeFakeProvider([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'hello', arguments: '{"name":"测试"}' }],
        finishReason: 'tool_calls',
      },
      { content: '任务完成', toolCalls: [], finishReason: 'stop' },
    ])

    const loop = new AgentLoop({ llm: provider, tools, session })
    const result = await loop.run('打个招呼')

    expect(provider.calls).toBe(2)
    expect(result.finishedReason).toBe('stop')
    expect(result.content).toBe('任务完成')

    // 模型可见即记录：user / assistant / tool / assistant
    const events = await session.events()
    expect(events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect((events[2].payload as { name: string }).name).toBe('hello')
  })

  it('agent/pre-step 返回 false 可拒绝执行', async () => {
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider = makeFakeProvider([{ content: '', toolCalls: [], finishReason: 'stop' }])
    const loop = new AgentLoop({
      llm: provider,
      tools: new ToolRegistryImpl(),
      session,
      emit: async (event) => (event === 'agent/pre-step' ? false : true),
    })
    const result = await loop.run('hi')
    expect(result.finishedReason).toBe('rejected')
    expect(provider.calls).toBe(0)
  })

  it('max-steps 达到上限结束', async () => {
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    // 每次都有工具调用 → 永不 stop
    const provider = makeFakeProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'hello', arguments: '{}' }], finishReason: 'tool_calls' },
    ])
    const tools = new ToolRegistryImpl()
    tools.register({ name: 'hello', description: '', schema: {}, execute: () => ({ text: 'x' }) })
    const loop = new AgentLoop({ llm: provider, tools, session }, { maxSteps: 3 })
    const result = await loop.run('loop')
    expect(result.finishedReason).toBe('max-steps')
    expect(result.steps).toBe(3)
  })

  it('history 入参会拼接到 system 之后、本次输入之前', async () => {
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    let received: ChatMessage[] = []
    const provider: ChatProvider = {
      name: 'capture',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        received = [...messages]
        return { content: '收到', toolCalls: [], finishReason: 'stop' }
      },
    }
    const loop = new AgentLoop({ llm: provider, tools: new ToolRegistryImpl(), session })
    await loop.run('第二问', [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '回答一' },
    ])
    expect(received.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(received[0]).toEqual({ role: 'system', content: expect.any(String) })
    expect(received[1]).toEqual({ role: 'user', content: '第一问' })
    expect(received[2]).toEqual({ role: 'assistant', content: '回答一' })
    expect(received[3]).toEqual({ role: 'user', content: '第二问' })
  })

  it('模型抛错返回 error', async () => {
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider: ChatProvider = {
      name: 'bad',
      async chat() {
        throw new Error('模型挂了')
      },
    }
    const loop = new AgentLoop({ llm: provider, tools: new ToolRegistryImpl(), session })
    const result = await loop.run('hi')
    expect(result.finishedReason).toBe('error')
    const events = await session.events()
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })
})
