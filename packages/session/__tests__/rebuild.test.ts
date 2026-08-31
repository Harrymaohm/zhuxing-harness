import { describe, expect, it } from 'vitest'
import { buildMessagesFromEvents } from '../src/rebuild.js'
import type { SessionEvent } from '../src/index.js'

function evt(type: SessionEvent['type'], payload: unknown): SessionEvent {
  return { id: Math.random().toString(36).slice(2), sessionId: 's1', ts: Date.now(), type, source: 'agent', payload }
}

describe('buildMessagesFromEvents', () => {
  it('跳过 system / error / subagent 事件', () => {
    const events = [
      evt('system', { boot: true }),
      evt('error', { reason: 'x' }),
      evt('subagent', { id: 'sub' }),
    ]
    expect(buildMessagesFromEvents(events)).toEqual([])
  })

  it('重建 user / assistant / tool 消息序列', () => {
    const events = [
      evt('user', { content: '第一问' }),
      evt('assistant', { content: '回答一', toolCalls: [{ id: 'c1', name: 'hello', arguments: '{}' }] }),
      evt('tool', { callId: 'c1', name: 'hello', args: {}, result: 'hi' }),
      evt('assistant', { content: '回答二' }),
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '回答一', toolCalls: [{ id: 'c1', name: 'hello', arguments: '{}' }] },
      { role: 'tool', content: 'hi', toolCallId: 'c1' },
      { role: 'assistant', content: '回答二', toolCalls: undefined },
    ])
  })

  it('空 user 内容与空 assistant 不产出消息', () => {
    const events = [evt('user', { content: '   ' }), evt('assistant', { content: '' })]
    expect(buildMessagesFromEvents(events)).toEqual([])
  })

  it('tool 结果以 result 字段字符串化', () => {
    const events = [
      evt('user', { content: 'q' }),
      evt('assistant', { content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }] }),
      evt('tool', { callId: 'c2', name: 'read', args: {}, result: { text: 'file content' } }),
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages[2]).toEqual({ role: 'tool', content: 'file content', toolCallId: 'c2' })
  })

  it('过滤孤儿 tool_calls（assistant 已发出但无 tool 响应）', () => {
    const events = [
      evt('user', { content: 'q' }),
      evt('assistant', { content: '先查一下', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] }),
      // 无对应的 tool 事件（进程中断 / run 打断）——toolCalls 被丢弃，正文保留
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: '先查一下', toolCalls: undefined }])
  })

  it('孤儿 tool_calls 且正文为空时整条 assistant 丢弃', () => {
    const events = [
      evt('user', { content: 'q' }),
      evt('assistant', { content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] }),
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([{ role: 'user', content: 'q' }])
  })

  it('部分响应的 tool_calls 只保留已响应部分', () => {
    const events = [
      evt('user', { content: 'q' }),
      evt('assistant', {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'a', arguments: '{}' },
          { id: 'c2', name: 'b', arguments: '{}' },
        ],
      }),
      evt('tool', { callId: 'c1', name: 'a', args: {}, result: 'ok' }),
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
    ])
  })

  it('纯文本 assistant 保留 content，toolCalls 为空时置 undefined', () => {
    const events = [
      evt('user', { content: 'q' }),
      evt('assistant', { content: '回答', toolCalls: [{ id: 'c1', name: 'a', arguments: '{}' }] }),
      // c1 无响应：toolCalls 被过滤，但 content 保留
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '回答', toolCalls: undefined },
    ])
  })

  it('user 事件带图片附件还原为多模态 content 数组', () => {
    const events = [
      evt('user', {
        content: '看看这张图',
        attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }],
      }),
    ]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ])
  })

  it('纯图片附件（无文本）也还原为 content 数组', () => {
    const events = [evt('user', { content: '', attachments: [{ type: 'image', dataUrl: 'data:image/jpeg;base64,BBB' }] })]
    const messages = buildMessagesFromEvents(events)
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } }] },
    ])
  })
})
