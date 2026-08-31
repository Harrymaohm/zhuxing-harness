import type { ChatMessage, ContentPart, ToolCall } from '@zhuxing/harness-llm'
import type { SessionEvent } from './index.js'

/** 事件 payload 的形状（与各 source 写入约定对齐）。 */
interface UserPayload {
  content?: string
  title?: string
  /** 多模态图片附件（data URL），重建时还原为 image_url 内容片段。 */
  attachments?: Array<{ type: 'image'; dataUrl: string }>
}
interface AssistantPayload {
  content?: string
  toolCalls?: ToolCall[] | Array<{ id: string; name: string; arguments: string }>
}
interface ToolPayload {
  callId?: string
  name?: string
  args?: Record<string, unknown>
  result?: unknown
}

/**
 * 从追加式会话事件重建模型可见消息序列（不含 system）。
 * 只回放模型可见的事件：user / assistant / tool；system / error / subagent 跳过。
 */
export function buildMessagesFromEvents(events: SessionEvent[]): ChatMessage[] {
  // 先收集全部已响应的 toolCallId。进程被中断 / run 被打断时，会话里可能留下
  // 「孤儿」tool_calls（assistant 已发出但无 tool 结果），OpenAI 兼容 API 要求每个
  // tool_call_id 都必须紧跟对应 tool 响应，孤儿调用必须在重建时过滤。
  const responded = new Set<string>()
  for (const evt of events) {
    if (evt.type === 'tool') {
      const callId = (evt.payload as ToolPayload).callId
      if (callId) responded.add(callId)
    }
  }

  const messages: ChatMessage[] = []
  for (const evt of events) {
    if (evt.type === 'user') {
      const payload = evt.payload as UserPayload
      const content = payload.content ?? ''
      const attachments = Array.isArray(payload.attachments) ? payload.attachments.filter((a) => a.dataUrl) : []
      if (attachments.length > 0) {
        const parts: ContentPart[] = []
        if (content.trim()) parts.push({ type: 'text', text: content })
        for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
        messages.push({ role: 'user', content: parts })
      } else if (content.trim()) {
        messages.push({ role: 'user', content })
      }
    } else if (evt.type === 'assistant') {
      const payload = evt.payload as AssistantPayload
      const content = payload.content ?? ''
      const toolCalls = Array.isArray(payload.toolCalls)
        ? (payload.toolCalls as ToolCall[])
            .filter((c) => c.id && responded.has(c.id))
            .map((c) => ({
              id: c.id,
              name: c.name,
              arguments: c.arguments,
            }))
        : undefined
      const safeCalls = toolCalls && toolCalls.length > 0 ? toolCalls : undefined
      if (content || safeCalls) messages.push({ role: 'assistant', content, toolCalls: safeCalls })
    } else if (evt.type === 'tool') {
      const payload = evt.payload as ToolPayload
      const callId = payload.callId ?? ''
      const result = payload.result
      let content: string
      if (typeof result === 'string') content = result
      else if (result !== null && typeof result === 'object') {
        const text = (result as { text?: unknown }).text
        content = typeof text === 'string' ? text : JSON.stringify(result)
      } else content = String(result ?? '')
      messages.push({
        role: 'tool',
        content,
        toolCallId: callId,
      })
    }
  }
  return messages
}
