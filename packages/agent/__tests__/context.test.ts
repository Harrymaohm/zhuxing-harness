import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult, ToolCall } from '@zhuxing/harness-llm'
import { estimateMessagesTokens, estimateTokens, contentText, manageContext, sanitizeMessages, summarizeHistory } from '../src/context.js'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function toolCall(id: string, name = 'exec'): ToolCall[] {
  return [{ id, name, arguments: '{}' }]
}

function assistantWithTools(content: string, ids: string[]): ChatMessage {
  return { role: 'assistant', content, toolCalls: toolCall(ids[0]).concat(ids.slice(1).map((id) => toolCall(id)[0])) }
}

function toolResult(id: string): ChatMessage {
  return { role: 'tool', content: 'ok', toolCallId: id }
}

describe('context 管理', () => {
  it('预算内全量保留', async () => {
    const messages = [msg('user', '你好'), msg('assistant', '在的')]
    const result = await manageContext(messages, { maxTokens: 1000 })
    expect(result.trimmed).toBe(false)
    expect(result.messages).toHaveLength(2)
  })

  it('超预算时保留最近消息（滑动窗口）', async () => {
    const messages = [
      msg('user', 'a'.repeat(2000)),
      msg('assistant', 'b'.repeat(2000)),
      msg('user', '最近的问题'),
    ]
    const result = await manageContext(messages, { maxTokens: 100 })
    expect(result.trimmed).toBe(true)
    expect(result.summarized).toBe(false)
    expect(result.messages[0]).toEqual(msg('user', '最近的问题'))
    expect(result.keptCount).toBeLessThan(messages.length)
  })

  it('提供 llm 时对早期历史生成摘要', async () => {
    const early = [msg('user', '早期问题'), msg('assistant', '早期答案'), msg('tool', '噪音')]
    const llm: ChatProvider = {
      name: 'summarizer',
      async chat(): Promise<ChatResult> {
        return { content: '早期摘要：讨论了早期问题。', toolCalls: [], finishReason: 'stop' }
      },
    }
    const summary = await summarizeHistory(early, llm)
    expect(summary).toContain('早期摘要')
    expect(summary).not.toContain('噪音')
  })

  it('summary 失败时回退为纯窗口裁剪', async () => {
    const messages = [msg('user', 'x'.repeat(1500)), msg('assistant', 'y'.repeat(1500))]
    const llm: ChatProvider = {
      name: 'broken',
      async chat() {
        throw new Error('挂了')
      },
    }
    const result = await manageContext(messages, { maxTokens: 50, llm })
    expect(result.trimmed).toBe(true)
    expect(result.summarized).toBe(false)
    expect(result.messages[0].content).toBe('y'.repeat(1500))
  })

  it('estimateTokens 使用字符/token 近似', () => {
    expect(estimateTokens('abcd')).toBe(2) // 4/3.5 ≈ 1.14 → 2
    expect(estimateTokens('')).toBe(0)
    expect(estimateMessagesTokens([msg('user', '中文内容一二三四五六七八九十')])).toBeGreaterThan(0)
  })

  it('contentText 取纯文本，多模态数组拼接 text 片段', () => {
    expect(contentText('纯文本')).toBe('纯文本')
    expect(
      contentText([
        { type: 'text', text: '第一段' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段\n第二段')
    expect(contentText([])).toBe('')
  })

  it('estimateMessagesTokens 对多模态图片额外估算', () => {
    const textOnly = [{ role: 'user', content: '你好' }] as ChatMessage[]
    const withImage = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '你好' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ],
      },
    ] as ChatMessage[]
    expect(estimateMessagesTokens(withImage)).toBeGreaterThan(estimateMessagesTokens(textOnly))
  })
})

describe('sanitizeMessages（工具消息序列清理）', () => {
  it('正常工具序列保持不变', () => {
    const messages = [
      msg('user', 'q'),
      assistantWithTools('', ['c1']),
      toolResult('c1'),
      msg('assistant', '完成'),
    ]
    expect(sanitizeMessages(messages)).toEqual(messages)
  })

  it('丢弃孤儿 tool（assistant 被裁剪后残留）', () => {
    const messages = [toolResult('c1'), msg('user', 'q')]
    expect(sanitizeMessages(messages)).toEqual([msg('user', 'q')])
  })

  it('未闭合的 tool_calls 过滤为已响应部分', () => {
    const messages = [
      msg('user', 'q'),
      assistantWithTools('', ['c1', 'c2']),
      toolResult('c1'),
      msg('user', '继续'),
    ]
    const out = sanitizeMessages(messages)
    expect(out).toEqual([
      msg('user', 'q'),
      assistantWithTools('', ['c1']),
      toolResult('c1'),
      msg('user', '继续'),
    ])
  })

  it('无响应且无正文的 assistant 整条丢弃', () => {
    const messages = [msg('user', 'q'), assistantWithTools('', ['c1'])]
    expect(sanitizeMessages(messages)).toEqual([msg('user', 'q')])
  })

  it('工具序列被纯文本 assistant 打断时丢弃该纯文本消息', () => {
    const messages = [
      msg('user', 'q'),
      assistantWithTools('', ['c1']),
      msg('assistant', '稍等'),
      toolResult('c1'),
    ]
    const out = sanitizeMessages(messages)
    expect(out).toEqual([
      msg('user', 'q'),
      assistantWithTools('', ['c1']),
      toolResult('c1'),
    ])
  })
})
