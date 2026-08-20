import { describe, expect, it } from 'vitest'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import type { ChatMessage, ChatProvider } from '@zhuxing/harness-llm'
import { AgentLoop, foldResult } from '../src/index.js'

describe('迭代数据保留与最终折叠', () => {
  it('中间数据完整保留并参与后续迭代；仅在最终输出时折叠', async () => {
    const seen: ChatMessage[][] = []
    let calls = 0
    const provider: ChatProvider = {
      name: 'record',
      async chat(messages) {
        seen.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
        calls++
        if (calls === 1) {
          return { content: '', toolCalls: [{ id: 'c1', name: 'calc', arguments: '{"a":2,"b":3}' }], finishReason: 'tool_calls' }
        }
        return { content: '计算结果：2 + 3 = 5', toolCalls: [], finishReason: 'stop' }
      },
    }
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'calc',
      description: '加法',
      schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      execute: (args) => ({ text: `结果=${String(args.a)} + ${String(args.b)} = 5` }),
    })
    const store = new MemorySessionStore()
    const session = new SessionImpl(store, await store.createSession())
    const loop = new AgentLoop({ llm: provider, tools, session })
    const result = await loop.run('计算 2+3')

    // 1. 会话日志保留全部中间数据（含完整参数与结果，未折叠）
    const events = await session.events()
    expect(events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolEvt = events[2].payload as { name: string; args: unknown; result: unknown }
    expect(toolEvt.name).toBe('calc')
    expect(toolEvt.args).toEqual({ a: 2, b: 3 })
    expect(toolEvt.result).toEqual({ text: '结果=2 + 3 = 5' })

    // 2. 中间结果参与后续迭代：第二轮模型消息包含第一轮工具结果文本
    expect(seen).toHaveLength(2)
    const second = seen[1]
    const last = second[second.length - 1]
    expect(last).toMatchObject({ role: 'tool', toolCallId: 'c1' })
    expect(String(last.content)).toContain('结果=2 + 3 = 5')

    // 3. 最终输出折叠：生成交付摘要，但完整数据仍保留在日志（折叠不删除）
    const folded = foldResult(result, events)
    expect(folded.steps).toBe(2)
    expect(folded.summary).toContain('计算结果')
    expect(folded.toolsUsed).toEqual([{ name: 'calc', calls: 1 }])
    expect(folded.sessionId).toBe(session.id)
    expect(folded.fullLogAvailable).toBe(true)
    expect(events.length).toBe(4) // 折叠后日志数据完整无缺
  })

  it('折叠摘要仅截断最终输出，不触碰中间数据', async () => {
    const events = [] as unknown[]
    const result = {
      content: 'x'.repeat(500),
      steps: 3,
      sessionId: 's1',
      finishedReason: 'stop' as const,
    }
    const folded = foldResult(result, events as never)
    expect(folded.summary.length).toBeLessThan(result.content.length)
    expect(events.length).toBe(0) // 折叠操作不修改会话数据
  })
})
