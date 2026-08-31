import type { ChatMessage, ChatProvider } from '@zhuxing/harness-llm'

/** token 近似估算：中文约 1.5~2 token/字、代码约 4 字符/token，取中值 3.5 字符/token。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** 取消息的纯文本（多模态 content 数组时拼接 text 片段；图片忽略）。 */
export function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
  return ''
}

/** 单张图片的 token 近似估算（vision 基础开销）。 */
const IMAGE_TOKEN_ESTIMATE = 85

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(contentText(m.content))
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'image_url') total += IMAGE_TOKEN_ESTIMATE
    }
    if (m.toolCalls) {
      for (const c of m.toolCalls) total += estimateTokens(c.arguments)
    }
  }
  return total
}

export interface ManageContextOptions {
  /** 上下文预算（token），超出即滑动窗口裁剪。 */
  maxTokens: number
  /** 摘要模型（无模型或失败时回退为纯窗口裁剪）。 */
  llm?: ChatProvider
}

export interface ManageContextResult {
  messages: ChatMessage[]
  /** 是否发生裁剪。 */
  trimmed: boolean
  /** 是否生成了历史摘要。 */
  summarized: boolean
  /** 窗口内保留的消息数。 */
  keptCount: number
}

/**
 * 上下文管理：预算内全量保留；超预算时从最近消息往回滑动窗口，
 * 对早期被裁掉的 user/assistant 文本调用模型生成摘要（作为 system 摘要消息置前）。
 */
export async function manageContext(
  messages: ChatMessage[],
  opts: ManageContextOptions,
): Promise<ManageContextResult> {
  const total = estimateMessagesTokens(messages)
  if (total <= opts.maxTokens) {
    return { messages, trimmed: false, summarized: false, keptCount: messages.length }
  }

  const kept: ChatMessage[] = []
  let acc = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessagesTokens([messages[i]])
    if (kept.length > 0 && acc + t > opts.maxTokens) break
    kept.unshift(messages[i])
    acc += t
  }
  const keptCount = kept.length
  // early：去掉首条 system 与窗口保留部分之间的历史
  const early = messages.slice(1, messages.length - keptCount)

  if (opts.llm && early.length > 0) {
    const summary = await summarizeHistory(early, opts.llm)
    if (summary.trim()) {
      return {
        messages: [messages[0], { role: 'system', content: `以下是更早的对话摘要：\n${summary}` }, ...kept],
        trimmed: true,
        summarized: true,
        keptCount,
      }
    }
  }
  return { messages: kept, trimmed: true, summarized: false, keptCount }
}

/**
 * 清理工具消息序列：丢弃无法配对的孤儿 tool / 未闭合的 tool_calls。
 * 会话重建、上下文裁剪（窗口截断 / 摘要插入）都可能切断 assistant(tool_calls)
 * 与其 tool 响应，而 OpenAI 兼容 API 严格要求 tool 消息紧跟其 tool_calls。
 * 在发送给模型前统一兜底，保证序列合法。
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pending = new Set<string>()
  let pendingIdx = -1
  const consumed = new Set<string>()

  const closePending = (): void => {
    if (pendingIdx < 0) return
    const cur = out[pendingIdx]
    const keptCalls = (cur.toolCalls ?? []).filter((c) => consumed.has(c.id))
    if (keptCalls.length === 0 && !contentText(cur.content)) out.splice(pendingIdx, 1)
    else out[pendingIdx] = { ...cur, toolCalls: keptCalls.length > 0 ? keptCalls : undefined }
    pending = new Set()
    pendingIdx = -1
  }

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      closePending()
      out.push(m)
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls ?? []
      if (calls.length > 0) {
        if (pendingIdx >= 0) continue
        pending = new Set(calls.map((c) => c.id))
        consumed.clear()
        pendingIdx = out.length
        out.push({ ...m, toolCalls: calls })
      } else {
        if (pendingIdx >= 0) continue
        out.push(m)
      }
    } else if (m.role === 'tool') {
      const id = m.toolCallId ?? ''
      if (pendingIdx >= 0 && pending.has(id)) {
        pending.delete(id)
        consumed.add(id)
        out.push(m)
        if (pending.size === 0) {
          pending = new Set()
          pendingIdx = -1
        }
      }
      // 孤儿 tool（无对应 tool_calls）：丢弃
    } else {
      out.push(m)
    }
  }
  closePending()
  return out
}

/** 对早期历史生成摘要：只取 user/assistant 文本，跳过工具结果噪音。 */
export async function summarizeHistory(early: ChatMessage[], llm: ChatProvider): Promise<string> {
  const lines = early
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${contentText(m.content).slice(0, 400)}`)
  if (lines.length === 0) return ''
  const prompt = `以下是较早的对话内容，请用简洁的中文概括要点，保留关键事实、结论与待办事项：\n\n${lines.join('\n')}`
  try {
    const res = await llm.chat(
      [
        { role: 'system', content: '你是对话摘要助手，只输出摘要本身。' },
        { role: 'user', content: prompt },
      ],
      {},
    )
    return res.content
  } catch {
    return ''
  }
}
