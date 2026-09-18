import type { ChatMessage, TraceItem } from '../types'

/**
 * 单步思考预算（与服务端 THINKING_STEP_BUDGET 保持一致）：
 * 会话日志里存的是全量思考，单步可达上万字；重建历史时按同一预算截断，
 * 否则「刷新后临时说明突然变长」，与实时观感不一致。
 */
export const THINKING_STEP_BUDGET = 3000

/** 单步思考按预算截断，超出部分以一行说明收尾。 */
export function capStepThinking(text: string): string {
  if (text.length <= THINKING_STEP_BUDGET) return text
  return `${text.slice(0, THINKING_STEP_BUDGET)}…（思考过长，本步已省略 ${text.length - THINKING_STEP_BUDGET} 字）`
}

/** 工具结果摘要（历史重建时展示在「调用」区）。 */
export function summarize(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { text?: string; error?: string; json?: unknown }
  if (typeof r === 'object') {
    if (r.error !== undefined) return `错误: ${r.error}`
    if (r.text !== undefined) return r.text
    if (r.json !== undefined) return JSON.stringify(r.json).slice(0, 120)
  }
  return String(result).slice(0, 120)
}

/** 会话事件的形状（重建只用到 type 与 payload 的一个子集）。 */
export interface SessionEventLike {
  type: string
  payload?: unknown
}

/** 重建时用到的 payload 字段。 */
interface RebuildPayload {
  content?: string
  thinking?: string
  name?: string
  result?: unknown
  toolCalls?: unknown
  attachments?: Array<{ type: string; dataUrl: string }>
  /** 本轮精炼出的任务书（落盘在 user 事件上，界面挂在助手消息里展示）。 */
  refined?: { instruction?: string }
}

/**
 * 从会话事件重建前端消息列表（历史会话 / 子对话共用）。
 * Trae 风格：一个「回合」（用户输入 → 多步模型调用/工具 → 结论）合并为一条助手消息，
 * 含思考（reasoning_content）、调用过程（工具命令+回复）与最终结论，且与实时 SSE 观感一致；
 * 纯文本回复（无工具调用）仅保留文字，不产生执行过程骨架。
 *
 * 实现上刻意用「数组累加 + 收尾 join」而不是每次 `x = [x, y].join()`：
 * 后者是逐事件复制整段字符串的 O(n²)，在几百个事件的会话里表现为「点开要等好几秒」。
 */
export function rebuildMessages(
  events: SessionEventLike[],
  sessionId: string | undefined,
  nextId: () => string,
): ChatMessage[] {
  const list: ChatMessage[] = []
  let pending: ChatMessage | null = null
  let thinkParts: string[] = []
  let traceItems: TraceItem[] = []
  let toolStep = 0
  let turnHasTool = false
  let pendingBrief = ''

  /** 把累积的思考与调用轨迹写回 pending（每回合只 join 一次）。 */
  const flush = (): void => {
    if (!pending) return
    if (thinkParts.length > 0) pending.thinking = thinkParts.join('\n\n')
    pending.trace = traceItems.slice()
  }

  for (const evt of events) {
    const p = (evt.payload ?? {}) as RebuildPayload
    if (evt.type === 'user') {
      flush()
      pending = null
      thinkParts = []
      traceItems = []
      turnHasTool = false
      // 本轮精炼出的任务书（可能为空 = 判定无需拆解），挂到紧随其后的助手消息上
      pendingBrief = p.refined?.instruction?.trim() ?? ''
      const images = Array.isArray(p.attachments) ? p.attachments.filter((a) => a.dataUrl).map((a) => a.dataUrl) : []
      list.push({ id: nextId(), role: 'user', content: p.content ?? '', images: images.length > 0 ? images : undefined })
      continue
    }
    if (evt.type === 'assistant') {
      const toolCalls = Array.isArray(p.toolCalls)
        ? (p.toolCalls as Array<{ id?: string; name?: string; arguments?: string }>)
        : []
      if (!pending) {
        pending = { id: nextId(), role: 'assistant', content: '', sessionId, brief: pendingBrief || undefined }
        list.push(pending)
      }
      // 思考内容累积（多个推理 step 合并，逐 step 按预算截断）
      if (p.thinking) thinkParts.push(capStepThinking(p.thinking))
      if (toolCalls.length > 0) {
        // 过程步骤：调用工具前的零散片段描述也归入「思考」，不污染最终结论
        if (p.content) thinkParts.push(p.content)
        turnHasTool = true
        toolStep += 1
        traceItems.push({ type: 'step', step: toolStep })
        for (const tc of toolCalls) {
          traceItems.push({ type: 'tool', toolName: tc.name ?? '', toolArgs: tc.arguments ?? '' })
        }
      } else {
        // 交付步骤：只有最终交付的结论才进入 content；工具轮次补一个「结论」step 骨架
        pending.content = `${pending.content ?? ''}${p.content ?? ''}`
        if (turnHasTool) {
          toolStep += 1
          traceItems.push({ type: 'step', step: toolStep })
        }
        flush()
        pending = null
        turnHasTool = false
      }
      continue
    }
    if (evt.type === 'tool') {
      const name = String(p.name ?? '')
      const result = p.result ? summarize(p.result) : ''
      // 回填最近一条「同名且尚无结果」的工具项；找不到就追加
      // （历史日志可能缺对应的 assistant 记录，直接丢弃会让「调用」区少一条）
      let matched = false
      for (let i = traceItems.length - 1; i >= 0; i--) {
        const item = traceItems[i]
        if (item.type === 'tool' && item.toolName === name && item.toolResult === undefined) {
          traceItems[i] = { ...item, toolResult: result }
          matched = true
          break
        }
      }
      if (!matched) traceItems.push({ type: 'tool', toolName: name, toolResult: result })
    }
  }
  flush()
  return list
}
