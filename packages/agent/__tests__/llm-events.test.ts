/**
 * LLM 调用事件（`agent/llm-request` / `agent/llm-response` / `agent/llm-error`）契约测试。
 *
 * 这三个事件是遥测产出 GenAI inference（chat）span 的唯一来源：模型名、token 用量、耗时与成败
 * 必须能从事件里直接拿到，且成功与失败两条路径都要派发（只发成功路径等于只覆盖一半的 span）。
 */
import { describe, expect, it } from 'vitest'
import { EventBus } from '@zhuxing/harness-kernel'
import type { ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import { AgentLoop } from '../src/index.js'
import type { LlmErrorEvent, LlmRequestEvent, LlmResponseEvent } from '../src/index.js'

interface CapturedEvent {
  event: string
  payload: unknown
}

async function makeSession(): Promise<SessionImpl> {
  const store = new MemorySessionStore()
  return new SessionImpl(store, await store.createSession())
}

/** 按剧本返回结果的假 provider；剧本用尽后重复最后一条。 */
function scriptedProvider(script: Array<Partial<ChatResult>>): ChatProvider & { calls: number } {
  let calls = 0
  return {
    name: 'fake',
    get calls() {
      return calls
    },
    async chat(): Promise<ChatResult> {
      const step = script[Math.min(calls, script.length - 1)]
      calls += 1
      return { content: '', toolCalls: [], finishReason: 'stop', ...step }
    },
  }
}

/** 收集事件出口。 */
function collector(events: CapturedEvent[]): (event: string, payload?: unknown) => Promise<boolean> {
  return async (event, payload) => {
    events.push({ event, payload })
    return true
  }
}

describe('agent/llm-* 事件契约', () => {
  it('单次模型调用：llm-request → llm-response 各一次，字段齐备', async () => {
    const events: CapturedEvent[] = []
    const provider = scriptedProvider([
      {
        content: '你好',
        finishReason: 'stop',
        usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cacheHitTokens: 800, cacheMissTokens: 400 },
        raw: { model: 'deepseek-chat-0613' },
      },
    ])
    const session = await makeSession()
    const loop = new AgentLoop(
      { llm: provider, tools: new ToolRegistryImpl(), session, emit: collector(events) },
      { model: 'deepseek-chat' },
    )
    const result = await loop.run('打个招呼')
    expect(result.finishedReason).toBe('stop')
    const llmEvents = events.filter((e) => e.event.startsWith('agent/llm-'))
    expect(llmEvents.map((e) => e.event)).toEqual(['agent/llm-request', 'agent/llm-response'])

    const request = llmEvents[0].payload as LlmRequestEvent
    expect(request.sessionId).toBe(session.id)
    expect(request.step).toBe(0)
    expect(request.model).toBe('deepseek-chat')

    const response = llmEvents[1].payload as LlmResponseEvent
    expect(response.sessionId).toBe(session.id)
    expect(response.step).toBe(0)
    expect(response.model).toBe('deepseek-chat')
    // 实际服务模型取自 provider 响应体（raw.model）
    expect(response.responseModel).toBe('deepseek-chat-0613')
    // token 用量原样透传：promptTokens 是含缓存命中的输入总量
    expect(response.usage).toMatchObject({ promptTokens: 1200, completionTokens: 300, cacheHitTokens: 800 })
    expect(response.finishReasons).toEqual(['stop'])
    expect(response.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('工具编排轮次：每个 step 各一对 request/response，顺序与 step 号正确', async () => {
    const events: CapturedEvent[] = []
    const provider = scriptedProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'hello', arguments: '{"name":"x"}' }], finishReason: 'tool_calls' },
      { content: '完成', finishReason: 'stop' },
    ])
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'hello',
      description: '打招呼',
      schema: { type: 'object', properties: {} },
      execute: () => ({ text: '你好' }),
    })
    const session = await makeSession()
    const loop = new AgentLoop({ llm: provider, tools, session, emit: collector(events) })
    const result = await loop.run('打个招呼')
    expect(result.finishedReason).toBe('stop')
    expect(provider.calls).toBe(2)

    const llmEvents = events.filter((e) => e.event.startsWith('agent/llm-'))
    expect(llmEvents.map((e) => e.event)).toEqual([
      'agent/llm-request',
      'agent/llm-response',
      'agent/llm-request',
      'agent/llm-response',
    ])
    expect(llmEvents.map((e) => (e.payload as LlmRequestEvent).step)).toEqual([0, 0, 1, 1])
    expect(llmEvents.every((e) => (e.payload as LlmRequestEvent).sessionId === session.id)).toBe(true)
  })

  it('模型调用失败：派发 agent/llm-error（含低基数 error.type 与耗时）', async () => {
    const events: CapturedEvent[] = []
    const provider: ChatProvider = {
      name: 'boom',
      async chat() {
        throw new Error('模型请求超时（120000ms）')
      },
    }
    const session = await makeSession()
    const loop = new AgentLoop({ llm: provider, tools: new ToolRegistryImpl(), session, emit: collector(events) }, { model: 'm1' })
    const result = await loop.run('打个招呼')
    expect(result.finishedReason).toBe('error')
    const llmEvents = events.filter((e) => e.event.startsWith('agent/llm-'))
    expect(llmEvents.map((e) => e.event)).toEqual(['agent/llm-request', 'agent/llm-error'])

    const failure = llmEvents[1].payload as LlmErrorEvent
    expect(failure.sessionId).toBe(session.id)
    expect(failure.step).toBe(0)
    expect(failure.model).toBe('m1')
    expect(failure.errorType).toBe('timeout')
    expect(failure.message).toContain('超时')
    expect(failure.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('监听器抛异常不得中断主链路（事件派发需隔离单个监听器的异常）', async () => {
    const bus = new EventBus()
    bus.on('agent/llm-request', () => {
      throw new Error('listener boom')
    })
    const provider = scriptedProvider([{ content: '照常完成', finishReason: 'stop' }])
    const session = await makeSession()
    const loop = new AgentLoop(
      { llm: provider, tools: new ToolRegistryImpl(), session, emit: (event, payload) => bus.emit(event, payload) },
    )
    const result = await loop.run('打个招呼')
    expect(result.finishedReason).toBe('stop')
    expect(result.content).toBe('照常完成')
  })
})
