import type { ChatMessage, ChatOptions, ChatProvider, ChatResult, ChatStreamChunk } from '@zhuxing/harness-llm'

/** 子模型能力标签（预置意图词表基于这些标签做任务匹配）。 */
export type ModelCapability =
  | 'code'
  | 'reasoning'
  | 'creative'
  | 'analysis'
  | 'fast'
  | 'cheap'
  | 'long-context'
  | 'vision'
  | 'general'

/** 子模型注册元数据（统一模型交互接口的一部分）。 */
export interface ModelSpec {
  /** 唯一 id（如 'fast' / 'reasoner'）。 */
  id: string
  /** 人类可读标签（默认取 id）。 */
  label?: string
  /** 能力标签集合。 */
  capabilities?: ModelCapability[]
  /** 上下文窗口（token 数），用于上下文适配评分。 */
  contextWindow?: number
  /** 每千 token 成本估算（元，用于成本监控）。 */
  costPer1k?: number
}

/** 子模型配置条目（config.models 数组元素，bundle 据此构建 provider 并注册）。 */
export interface ModelConfigEntry extends ModelSpec {
  /** OpenAI 兼容模型名（如 'deepseek-chat'）。 */
  model: string
  /** 端点（缺省回退到主 baseUrl）。 */
  baseUrl?: string
  /** API Key（缺省回退到主 apiKey）。 */
  apiKey?: string
  /** 请求超时（ms）。 */
  timeoutMs?: number
}

/** 已注册的模型记录。 */
export interface RegisteredModel {
  spec: ModelSpec
  /** 统一模型交互接口：所有子模型对外呈现一致的 ChatProvider。 */
  provider: ChatProvider
  registeredAt: number
}

/** 实时性能指标（滑动窗口聚合）。 */
export interface ModelMetrics {
  calls: number
  ok: number
  fail: number
  /** 0..1，无调用数据时为 1（不惩罚）。 */
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  totalTokens: number
  estCost: number
  lastError?: string
}

/** 单次调用记录（监控原始数据）。 */
export interface ModelCallRecord {
  modelId: string
  ok: boolean
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
  estCost?: number
  error?: string
  ts: number
}

/** 模型注册表服务：模型插件管理框架（注册/注销/查询，支持热插拔）。 */
export interface ModelRegistry {
  /** 注册一个子模型，返回注销函数（建议绑定 ctx.effect，插件卸载时自动注销）。 */
  register(spec: ModelSpec, provider: ChatProvider): () => void
  unregister(modelId: string): void
  get(modelId: string): RegisteredModel | undefined
  list(): RegisteredModel[]
  has(modelId: string): boolean
}

/** 实时性能监控服务：每次调用埋点，滑动窗口聚合指标。 */
export interface ModelMonitor {
  /** 记录一次模型调用结果。 */
  record(call: ModelCallRecord): void
  /** 查询某模型最近窗口聚合指标。 */
  metrics(modelId: string): ModelMetrics
  /** 全部模型的指标快照。 */
  all(): Record<string, ModelMetrics>
}

/** 模型选择 hint。 */
export interface SelectOptions {
  /** 显式指定模型 id（置顶且不参与评分）。 */
  modelId?: string
  /** 能力偏好（评分加分）。 */
  capabilities?: ModelCapability[]
  /** 任务描述（优先于 messages 做意图分析）。 */
  task?: string
}

/** 选择器配置（权重默认：能力 0.5 / 上下文 0.2 / 性能 0.3）。 */
export interface SelectorConfig {
  capabilityWeight?: number
  contextWeight?: number
  performanceWeight?: number
  /** 低于该分数的候选被过滤（默认 0.15）。 */
  minScore?: number
  maxResults?: number
}

/** 模型选择结果。 */
export interface ModelChoice {
  modelId: string
  score: number
  /** 评分分解（调试 / 报告用）。 */
  breakdown: { capability: number; context: number; performance: number }
}

/** 模型间通信协议：子任务请求（编排模型 -> 子模型）。 */
export interface ModelTaskRequest {
  task: string
  /** 附加上下文（可省略）。 */
  context?: string
  hints?: SelectOptions & { maxTokens?: number; temperature?: number }
}

/** 模型间通信协议：统一子任务结果（无论子模型是谁，输出格式一致）。 */
export interface ModelTaskResult {
  ok: boolean
  /** 实际执行的子模型 id。 */
  modelId: string
  content: string
  usage?: ChatResult['usage']
  latencyMs: number
  estCost?: number
  error?: string
}

/** 路由选项：在标准 ChatOptions 之上扩展模型选择 hint。 */
export interface RouterOptions extends ChatOptions {
  /** 显式选择子模型 id（否则由选择算法自动决定）。 */
  modelId?: string
  /** 选择 hint（任务描述 / 能力偏好）。 */
  hints?: SelectOptions
  /** 首选失败时是否降级到次优模型（默认 true）。 */
  fallback?: boolean
}

/** 模型路由器：统一模型交互入口（实现 ChatProvider，对所有调用方呈现一致接口）。 */
export interface ModelRouter extends ChatProvider {
  /** 按当前输入与 hint 输出候选排序（不含调用）。 */
  route(messages: ChatMessage[], options?: RouterOptions): Promise<ModelChoice[]>
  /** 非流式调用（支持自动选择与失败降级）。 */
  chat(messages: ChatMessage[], options?: RouterOptions): Promise<ChatResult>
  /** 流式调用（支持自动选择）。 */
  stream(messages: ChatMessage[], options?: RouterOptions): AsyncIterable<ChatStreamChunk>
}

/** 编排服务：主编排模型通过它动态委派子任务给子模型。 */
export interface ModelOrchestrator {
  /** 委派一个子任务：选择子模型并执行，返回统一格式结果。 */
  delegate(req: ModelTaskRequest): Promise<ModelTaskResult>
  /** 列出可用子模型及其实时性能指标（供编排模型决策）。 */
  listModels(): Array<{ id: string; label: string; capabilities: ModelCapability[]; contextWindow?: number; metrics: ModelMetrics }>
}
