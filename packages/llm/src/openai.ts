import type { ChatMessage, ChatOptions, ChatProvider, ChatResult, ChatStreamChunk, ToolCall } from './types.js'

export interface OpenAICompatibleOptions {
  /** API Key。 */
  apiKey: string
  /** 基础地址，默认 OpenAI。 */
  baseUrl?: string
  /** 默认模型。 */
  model: string
  /** 请求超时（ms），默认 120s。 */
  timeoutMs?: number
}

interface OpenAIError {
  error?: { message?: string; type?: string }
}

/** OpenAI 兼容端点适配器：可对接任意 /v1/chat/completions 服务。 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string
  private baseUrl: string
  private model: string
  private apiKey: string
  private timeoutMs: number
  // DeepSeek 端点/模型检测：thinking、reasoning_effort 等专有参数仅对它下发，避免不兼容端点报错。
  private deepseek: boolean

  constructor(options: OpenAICompatibleOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.name = `openai-compatible:${this.model}`
    this.deepseek = /deepseek/i.test(`${this.baseUrl} ${this.model}`)
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${this.timeoutMs}ms）`)), this.timeoutMs)
    try {
      const body = this.buildBody(messages, options)

      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok) {
        let detail = ''
        try {
          const err = (await res.json()) as OpenAIError
          detail = err.error?.message ?? ''
        } catch {
          /* ignore parse error */
        }
        throw new Error(`模型请求失败（HTTP ${res.status}）：${detail || res.statusText}`)
      }

      const data = (await res.json()) as Record<string, any>
      const choice = data.choices?.[0]
      const msg = choice?.message ?? {}
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: Record<string, any>) => ({
        id: String(tc.id ?? `call_${Math.random().toString(36).slice(2)}`),
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      }))
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        toolCalls,
        finishReason: choice?.finish_reason ?? 'stop',
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
              cacheHitTokens: data.usage.prompt_cache_hit_tokens,
              cacheMissTokens: data.usage.prompt_cache_miss_tokens,
            }
          : undefined,
        reasoningContent: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
        raw: data,
      }
    } catch (err) {
      // 超时中止：归一化为清晰的超时错误
      if (controller.signal.aborted) {
        throw new Error(`模型请求超时（${this.timeoutMs}ms）`, { cause: err })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 流式聊天（SSE）：逐 token 产出增量文本，流结束时产出完整结果。
   * 兼容 OpenAI 的 data: [DONE] 结束与 tool_calls 增量累积。
   */
  async *stream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<ChatStreamChunk> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${this.timeoutMs}ms）`)), this.timeoutMs)
    try {
      const body = this.buildBody(messages, options)
      body.stream = true
      body.stream_options = { include_usage: true }

      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok) {
        let detail = ''
        try {
          const err = (await res.json()) as OpenAIError
          detail = err.error?.message ?? ''
        } catch {
          /* ignore parse error */
        }
        throw new Error(`模型请求失败（HTTP ${res.status}）：${detail || res.statusText}`)
      }
      if (!res.body) throw new Error('模型流式响应缺少 body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let content = ''
      let reasoning = ''
      const toolCalls: ToolCall[] = []
      let finishReason: string | undefined
      let usage: ChatResult['usage'] | undefined

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue
          let json: Record<string, any>
          try {
            json = JSON.parse(data) as Record<string, any>
          } catch {
            continue
          }
          const choice = json.choices?.[0]
          const delta = choice?.delta
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content
            yield { reasoning: delta.reasoning_content }
          }
          if (delta?.content) {
            content += delta.content
            yield { token: delta.content }
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls as Array<Record<string, any>>) {
              const index = tc.index ?? 0
              toolCalls[index] ??= { id: '', name: '', arguments: '' }
              if (tc.id) toolCalls[index].id = String(tc.id)
              if (tc.function?.name) toolCalls[index].name += tc.function.name
              if (tc.function?.arguments) toolCalls[index].arguments += tc.function.arguments
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
              cacheHitTokens: json.usage.prompt_cache_hit_tokens,
              cacheMissTokens: json.usage.prompt_cache_miss_tokens,
            }
          }
        }
      }
      yield {
        done: {
          content,
          toolCalls: toolCalls.filter(Boolean),
          finishReason: finishReason ?? 'stop',
          usage,
          reasoningContent: reasoning || undefined,
        },
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`模型请求超时（${this.timeoutMs}ms）`, { cause: err })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private buildBody(messages: ChatMessage[], options: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
        ...(m.role === 'tool' && m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.jsonMode) body.response_format = { type: 'json_object' }
    // DeepSeek 专有参数（官方文档：thinking.type 思考模式开关、reasoning_effort 思考强度）：
    // 编译器/选择器/摘要等机械调用传 thinking:'disabled'，思维链不再计入输出计费；非 DeepSeek 端点不下发。
    if (this.deepseek) {
      if (options.thinking) body.thinking = { type: options.thinking }
      if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }))
    }
    return body
  }
}
