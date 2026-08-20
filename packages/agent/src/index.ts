import type { ChatMessage, ChatProvider } from '@zhuxing/harness-llm'
import type { Sandbox } from '@zhuxing/harness-sandbox'
import type { Session } from '@zhuxing/harness-session'
import type { ToolExecuteContext, ToolRegistry, ToolResult } from '@zhuxing/harness-tools'
import { toToolResultText } from '@zhuxing/harness-tools'
import type { Logger } from '@zhuxing/harness-kernel'

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

  async run(userInput: string): Promise<AgentResult> {
    const { llm, tools, session, sandbox, emit, logger } = this.deps
    const maxSteps = this.opts.maxSteps ?? 20
    const systemPrompt = this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ]
    const executeCtx: ToolExecuteContext = { sandbox, logger, emit }
    const sessionId = session.id

    // 模型可见即记录：用户输入入日志
    await session.append('user', 'agent', { content: userInput })

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
        result = await this.callLlm(llm, messages, {
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
