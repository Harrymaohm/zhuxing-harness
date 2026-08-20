import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatStreamChunk } from '@zhuxing/harness-llm'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import { AgentLoop } from '../src/index.js'

function streamingProvider(): ChatProvider & { calls: number } {
  let calls = 0
  return {
    name: 'stream-fake',
    get calls() {
      return calls
    },
    async chat(_messages: ChatMessage[]): Promise<import('@zhuxing/harness-llm').ChatResult> {
      calls++
      return { content: 'fallback', toolCalls: [], finishReason: 'stop' }
    },
    async *stream(_messages: ChatMessage[]): AsyncIterable<ChatStreamChunk> {
      calls++
      yield { token: '流' }
      yield { token: '式' }
      yield { token: '输出' }
      yield { done: { content: '流式输出', toolCalls: [], finishReason: 'stop' } }
    },
  }
}

describe('Agent 流式透传（onToken）', () => {
  it('onToken 收集增量 token，结果来自流式 done', async () => {
    const tools = new ToolRegistryImpl()
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider = streamingProvider()
    const tokens: string[] = []
    const loop = new AgentLoop({ llm: provider, tools, session }, { onToken: (t) => tokens.push(t) })
    const result = await loop.run('hi')
    expect(provider.calls).toBe(1)
    expect(tokens).toEqual(['流', '式', '输出'])
    expect(result.content).toBe('流式输出')
    expect(result.finishedReason).toBe('stop')
  })

  it('无 onToken 时回退 chat', async () => {
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const provider = streamingProvider()
    const loop = new AgentLoop({ llm: provider, tools: new ToolRegistryImpl(), session })
    const result = await loop.run('hi')
    expect(provider.calls).toBe(1)
    expect(result.content).toBe('fallback')
  })
})
