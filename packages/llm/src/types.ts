/** 多模态内容片段：文本或图片（OpenAI vision 兼容）。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 统一聊天消息类型（OpenAI 风格子集）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 纯文本，或多模态内容片段数组（user 消息可携带图片）。 */
  content: string | ContentPart[]
  /** assistant 消息可选名称。 */
  name?: string
  /** assistant 消息可携带上一轮的工具调用（供模型继续编排）。 */
  toolCalls?: ToolCall[]
  /** tool 角色消息必须携带被调用的工具调用 id。 */
  toolCallId?: string
}

/** 模型返回的工具调用。 */
export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串参数。 */
  arguments: string
}

/** 模型返回结果。 */
export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
  raw?: unknown
}

/** 模型可见的工具描述（工具 schema 并入提示词组装）。 */
export interface ChatTool {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  tools?: ChatTool[]
  signal?: AbortSignal
}

/** 流式聊天增量块。 */
export interface ChatStreamChunk {
  /** 增量文本（可能为空，用于 token 级渲染）。 */
  token?: string
  /** 流结束时携带完整结果。 */
  done?: ChatResult
}

/** 模型适配器统一接口（ctx.llm 服务类型）。 */
export interface ChatProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  /** 可选：流式聊天（SSE）。不支持时可省略，调用方回退到 chat。 */
  stream?(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>
}
