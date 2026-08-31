import type { ChatMessage, ChatProvider } from '@zhuxing/harness-llm'
import type { Sandbox } from '@zhuxing/harness-sandbox'
import type { Session } from '@zhuxing/harness-session'
import type { ToolExecuteContext, ToolRegistry, ToolResult } from '@zhuxing/harness-tools'
import { toToolResultText } from '@zhuxing/harness-tools'
import type { Logger } from '@zhuxing/harness-kernel'
import { estimateMessagesTokens, manageContext, sanitizeMessages } from './context.js'

export interface AgentDeps {
  llm: ChatProvider
  tools: ToolRegistry
  session: Session
  sandbox?: Sandbox
  /** 事件出口：agent/pre-step（可拒绝）、agent/post-step、tools/* 由工具管道自行触发。 */
  emit?: (event: string, payload?: unknown) => Promise<boolean>
  logger?: Logger
}

export interface AgentOptions {
  systemPrompt?: string
  maxSteps?: number
  model?: string
  temperature?: number
  /** 流式输出：每次模型增量文本回调（要求 provider 支持 stream）。 */
  onToken?: (token: string) => void
  /** 上下文预算（token）：超出即滑动窗口 + 早期摘要（默认 32000）。 */
  contextWindow?: number
  /** 摘要触发阈值：低于该 token 数即触发（默认等于 contextWindow）。 */
  summarizeThreshold?: number
  /** 本轮用户消息附带的多模态图片附件（data URL，作为 image_url 内容片段）。 */
  attachments?: Array<{ type: 'image'; dataUrl: string }>
}

export type AgentFinishedReason = 'stop' | 'max-steps' | 'rejected' | 'error'

export interface AgentResult {
  content: string
  steps: number
  sessionId: string
  finishedReason: AgentFinishedReason
  /** 最后一步的原始模型响应（调试用）。 */
  lastRaw?: unknown
}

/** 工具使用统计。 */
export interface ToolUsageStat {
  name: string
  calls: number
}

/**
 * 交付折叠视图：仅在「生成最终输出」时折叠，产出精炼摘要。
 * 迭代过程中的全部中间数据（临时数据、过程变量、中间计算结果、步骤信息）
 * 始终完整保留在会话日志中（`fullLogAvailable: true`），可随时回放/续跑。
 */
export interface FoldedDelivery {
  summary: string
  steps: number
  finishedReason: AgentFinishedReason
  toolsUsed: ToolUsageStat[]
  sessionId: string
  fullLogAvailable: true
}

/** 依据完整会话日志生成交付摘要（最终输出折叠）。 */
export function foldResult(result: AgentResult, events: import('@zhuxing/harness-session').SessionEvent[]): FoldedDelivery {
  const counts = new Map<string, number>()
  for (const evt of events) {
    if (evt.type === 'tool') {
      const name = String((evt.payload as { name?: string }).name ?? '')
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return {
    summary: result.content.slice(0, 300),
    steps: result.steps,
    finishedReason: result.finishedReason,
    toolsUsed: [...counts.entries()].map(([name, calls]) => ({ name, calls })),
    sessionId: result.sessionId,
    fullLogAvailable: true,
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful coding agent running inside the Zhuxing Harness. ' +
  'Read the provided tools and call them when needed to accomplish the task. ' +
  'Prefer using tools over guessing. After the task is done, reply with a concise summary.'

/**
 * Agent 循环：step = 一次模型请求 + 其调用的工具；turn = 零到多个 step。
 * 模型可见的一切输入（系统提示、用户输入、工具结果）都追加进会话日志。
 */
export class AgentLoop {
  constructor(
    private deps: AgentDeps,
    private opts: AgentOptions = {},
  ) {}

  async run(userInput: string, history?: ChatMessage[]): Promise<AgentResult> {
    const { llm, tools, session, sandbox, emit, logger } = this.deps
    const maxSteps = this.opts.maxSteps ?? 70
    const systemPrompt = this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
    // 历史续接：重建的会话历史（user/assistant/tool）拼接在 system 之后、本次输入之前
    if (history && history.length > 0) messages.push(...history)
    // 本轮用户输入：有图片附件时组装为多模态 content 数组，否则纯文本
    const attachments = this.opts.attachments ?? []
    const userContent: ChatMessage['content'] =
      attachments.length > 0
        ? [{ type: 'text', text: userInput }, ...attachments.map((a) => ({ type: 'image_url' as const, image_url: { url: a.dataUrl } }))]
        : userInput
    messages.push({ role: 'user', content: userContent })

    // 上下文管理：超预算时滑动窗口裁剪 + 早期摘要（只在 run 开始时执行一次）
    const contextWindow = this.opts.contextWindow ?? 32000
    const threshold = this.opts.summarizeThreshold ?? contextWindow
    let historyTrimmed = false
    let historySummarized = false
    let keptCount = messages.length
    if (estimateMessagesTokens(messages) > threshold) {
      const managed = await manageContext(messages, { maxTokens: contextWindow, llm })
      if (managed.trimmed) {
        messages.length = 0
        messages.push(...managed.messages)
        historyTrimmed = true
        historySummarized = managed.summarized
        keptCount = managed.keptCount
      }
    }
    if (historyTrimmed) {
      await session.append('system', 'agent', {
        contextTrimmed: true,
        summarized: historySummarized,
        keptCount,
      })
    }

    const executeCtx: ToolExecuteContext = { sandbox, logger, emit }
    const sessionId = session.id
    // 工具执行上下文携带当前会话 id，供 remember 等工具写入会话私有内容
    executeCtx.sessionId = sessionId

    // 模型可见即记录：用户输入入日志（含图片附件，供历史重建还原多模态上下文）
    await session.append('user', 'agent', {
      content: userInput,
      attachments: attachments.length > 0 ? attachments : undefined,
    })

    for (let step = 0; step < maxSteps; step++) {
      // pre-step：策略插件可改写/拒绝本次模型请求
      if (emit) {
        const allowed = await emit('agent/pre-step', { sessionId, step, messageCount: messages.length })
        if (allowed === false) {
          await session.append('error', 'agent', { reason: 'agent/pre-step rejected' })
          return { content: '', steps: step, sessionId, finishedReason: 'rejected' }
        }
      }

      const chatTools = tools.list().length > 0 ? tools.toChatTools() : undefined
      let result
      try {
        // 发模型前清理序列：会话重建 / 上下文裁剪可能切断 tool_calls 与 tool 响应，统一兜底
        result = await this.callLlm(llm, sanitizeMessages(messages), {
          tools: chatTools,
          model: this.opts.model,
          temperature: this.opts.temperature,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await session.append('error', 'llm', { message: msg })
        return { content: '', steps: step + 1, sessionId, finishedReason: 'error', lastRaw: msg }
      }

      // 模型可见即记录：assistant 响应入日志
      await session.append('assistant', 'llm', { content: result.content, toolCalls: result.toolCalls })
      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })

      if (!result.toolCalls || result.toolCalls.length === 0) {
        await emit?.('agent/post-step', { sessionId, step, done: true })
        return { content: result.content, steps: step + 1, sessionId, finishedReason: 'stop', lastRaw: result.raw }
      }

      // 逐个执行工具调用
      for (const call of result.toolCalls) {
        let args: Record<string, unknown>
        try {
          args = JSON.parse(call.arguments) as Record<string, unknown>
        } catch {
          args = {}
        }
        const toolResult: ToolResult = await tools.execute(call.name, args, executeCtx)
        // 模型可见即记录：工具结果入日志
        await session.append('tool', 'agent', { callId: call.id, name: call.name, args, result: toolResult })
        messages.push({ role: 'tool', content: toToolResultText(toolResult), toolCallId: call.id })
      }

      await emit?.('agent/post-step', { sessionId, step, done: false })
    }

    await session.append('error', 'agent', { reason: `max-steps reached (${maxSteps})` })
    return { content: '', steps: maxSteps, sessionId, finishedReason: 'max-steps' }
  }

  /** 调用模型：onToken 且 provider 支持流式时走 stream，否则回退 chat。 */
  private async callLlm(
    llm: ChatProvider,
    messages: ChatMessage[],
    options: import('@zhuxing/harness-llm').ChatOptions,
  ): Promise<import('@zhuxing/harness-llm').ChatResult> {
    if (this.opts.onToken && typeof llm.stream === 'function') {
      let result: import('@zhuxing/harness-llm').ChatResult | undefined
      for await (const chunk of llm.stream(messages, options)) {
        if (chunk.token) this.opts.onToken(chunk.token)
        if (chunk.done) result = chunk.done
      }
      if (result) return result
    }
    return llm.chat(messages, options)
  }
}

export { DEFAULT_SYSTEM_PROMPT }
export { estimateTokens, estimateMessagesTokens, manageContext, sanitizeMessages, summarizeHistory, contentText } from './context.js'
export type { ManageContextOptions, ManageContextResult } from './context.js'
