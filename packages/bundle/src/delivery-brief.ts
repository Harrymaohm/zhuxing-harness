/** 交付简报与「参考对话」注入：会话结束沉淀简报，引用其它会话时优先注入简报而非完整记录。 */
import type { AgentResult } from '@zhuxing/harness-agent'
import type { SessionEvent } from '@zhuxing/harness-session'
import type { MemoryEntry } from '@zhuxing/harness-memory'

/** 把模型可见消息转成可读文本，用于把参考对话渲染成上下文记录。 */
export function messageToContextText(msg: import('@zhuxing/harness-llm').ChatMessage): string {
  const role = msg.role.toUpperCase()
  let body: string
  if (typeof msg.content === 'string') {
    body = msg.content
  } else {
    body = msg.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
  }
  if (msg.toolCalls?.length) {
    body = `${body}\n[调用工具: ${msg.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(', ')}]`.trim()
  }
  if (msg.role === 'tool') {
    body = `[工具结果:${msg.name ?? 'tool'} ${msg.toolCallId ?? ''}] ${body}`.trim()
  }
  return `${role}: ${body}`
}

/** 交付简报在会话私有记忆中的标签：注入参考对话时优先取其摘要而非完整记录。 */
export const DELIVERY_BRIEF_TAG = 'delivery-brief'

/** 参考对话简报的注入上限：份数 + 字符双限。长对话会沉淀几十份简报，全量注入会持续膨胀上下文。 */
const MAX_REF_BRIEFS = 6
const MAX_REF_BRIEF_CHARS = 4000
/** 单个会话保留的交付简报上限：只留最近若干份，旧的清理，避免记忆库随对话轮数无限膨胀。 */
export const MAX_SESSION_BRIEFS = 20

/** 「参考对话」注入上限（字符）：被引用会话完整记录可能很长，防止一次性撑爆 systemPrompt。 */
export const MAX_REF_CONTEXT_CHARS = 16000

/**
 * 从按时间升序的交付简报中挑出「最近且总量不超预算」的一段（保持时间顺序）。
 * 份数上限挡条数，字符上限挡个别超长简报。
 */
export function pickRecentBriefs(
  entries: MemoryEntry[],
  maxCount = MAX_REF_BRIEFS,
  maxChars = MAX_REF_BRIEF_CHARS,
): MemoryEntry[] {
  const kept = entries.slice(-maxCount)
  let used = kept.reduce((n, e) => n + e.content.length, 0)
  while (kept.length > 1 && used > maxChars) {
    used -= kept[0].content.length
    kept.shift()
  }
  return kept
}

/**
 * 生成「交付简报」：每次 agent 给出最终答复（finishedReason=stop）后自动沉淀的一份简要「过程+背景」说明。
 * 供后续「参考对话注入」优先注入，避免反复引入冗长的完整对话记录。
 */
export function buildDeliveryBrief(
  input: string,
  result: AgentResult,
  events: SessionEvent[],
): string {
  const counts = new Map<string, number>()
  for (const evt of events) {
    if (evt.type === 'tool') {
      const name = String((evt.payload as { name?: string }).name ?? '')
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const tools =
    counts.size > 0
      ? `调用工具 ${[...counts.entries()].map(([n, c]) => `${n}×${c}`).join(', ')}`
      : '未调用工具'
  return [
    `背景：${input.slice(0, 300)}`,
    `过程：共 ${result.steps} 步，${tools}。`,
    `交付：${result.content.slice(0, 600)}`,
  ].join('\n')
}
