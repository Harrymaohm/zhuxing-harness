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

  it('工具参数不是合法 JSON 时不执行该工具，把错误回注给模型', async () => {
    const tools = new ToolRegistryImpl()
    let executed = 0
    tools.register({
      name: 'write_file',
      description: '写文件',
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: () => {
        executed += 1
        return { text: '已写入' }
      },
    })

    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider = makeFakeProvider([
      {
        content: '',
        // 截断的 JSON：参数不可解析
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: '{"path": "a.ts"' }],
        finishReason: 'tool_calls',
      },
      { content: '我修正参数后重试', toolCalls: [], finishReason: 'stop' },
    ])

    const loop = new AgentLoop({ llm: provider, tools, session })
    const result = await loop.run('写个文件')

    // 关键行为：宁可这一轮失败，也不能带着被静默置空的参数去执行写操作
    expect(executed).toBe(0)
    expect(result.finishedReason).toBe('stop')

    // 错误必须回注给模型（role: tool），模型才有机会自我修正
    const events = await session.events()
    const toolEvent = events.find((e) => e.type === 'tool')
    expect((toolEvent?.payload as { result: { error?: string } }).result.error).toContain('不是合法 JSON')
    const fedBack = events.filter((e) => e.type === 'tool').length
    expect(fedBack).toBe(1)
  })

  it('工具结果里的裸凭据形态值无条件脱敏（不依赖工具名/参数线索）', async () => {
    // 背景：脱敏原先只在「工具名/参数/结果里出现凭据关键词」时才执行。
    // 实测反例：MCP 工具（名称与参数都不含关键词）返回一个裸 sk- 令牌，会明文进 append-only 会话日志。
    // 这条出口必须无条件兜底——形态识别代价极低，而漏一次就是永久落盘。
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'fetch_meta',
      description: '取元信息',
      schema: { type: 'object', properties: {} },
      execute: () => ({ text: 'raw=sk-abcdef1234567890' }),
    })
    tools.register({
      name: 'fetch_meta_json',
      description: '取元信息（结构化）',
      schema: { type: 'object', properties: {} },
      execute: () => ({ json: { nested: { token: 'sk-abcdef1234567890' } } }),
    })

    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider = makeFakeProvider([
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'fetch_meta', arguments: '{}' },
          { id: 'c2', name: 'fetch_meta_json', arguments: '{}' },
        ],
        finishReason: 'tool_calls',
      },
      { content: '完成', toolCalls: [], finishReason: 'stop' },
    ])
    const loop = new AgentLoop({ llm: provider, tools, session })
    await loop.run('取一下元信息')

    const logged = JSON.stringify((await session.events()).filter((e) => e.type === 'tool').map((e) => e.payload))
    expect(logged).not.toContain('sk-abcdef1234567890')
    // 上下文必须保留：证明是「脱敏」而不是把工具结果整个丢掉（丢结果会破坏 agent 的可用性）
    expect(logged).toContain('raw=')
    // 结构化结果在未检出机密时必须保持 json 形状（不被无谓地降级成文本）
    const noSecretTools = new ToolRegistryImpl()
    noSecretTools.register({
      name: 'plain_json',
      description: '普通结构化结果',
      schema: { type: 'object', properties: {} },
      execute: () => ({ json: { ok: true } }),
    })
    const session2 = new SessionImpl(store, await store.createSession())
    const loop2 = new AgentLoop({
      llm: makeFakeProvider([
        { content: '', toolCalls: [{ id: 'c1', name: 'plain_json', arguments: '{}' }], finishReason: 'tool_calls' },
        { content: '完成', toolCalls: [], finishReason: 'stop' },
      ]),
      tools: noSecretTools,
      session: session2,
    })
    await loop2.run('取普通结果')
    const plain = (await session2.events()).find((e) => e.type === 'tool')
    expect((plain?.payload as { result: { json?: unknown } }).result.json).toEqual({ ok: true })
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
