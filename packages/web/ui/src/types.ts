export interface TraceItem {
  type: 'step' | 'tool'
  step?: number
  toolName?: string
  toolArgs?: string
  toolResult?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'step'
  content?: string
  /** 图片附件（data URL，历史会话还原 / 实时拖入）。 */
  images?: string[]
  toolName?: string
  toolArgs?: string
  toolResult?: string
  error?: boolean
  /** 实时运行中（历史会话重建时不设此字段 = 已完成）。 */
  running?: boolean
  step?: number
  sessionId?: string
  steps?: number
  finishedReason?: string
  trace?: TraceItem[]
}

export interface SessionItem {
  id: string
  eventCount: number
  createdAt?: number
  preview?: string
  title?: string
  /** 分叉来源会话 id（子对话）。 */
  parentId?: string
  forkPointEventId?: string
  /** 所属空间（项目）id；空串/缺省为默认空间。 */
  spaceId?: string
  /** 软归档标记。 */
  archived?: boolean
  archivedAt?: number
}

/** 空间（项目）容器：隔离不同主题的会话。 */
export interface SpaceItem {
  id: string
  title: string
  sessionCount?: number
  createdAt?: number
  updatedAt?: number
}

export interface SubModelEntry {
  id: string
  model: string
  label?: string
  capabilities?: string[]
  contextWindow?: number
  costPer1k?: number
  baseUrl?: string
  apiKey?: string
}

export interface ImageModelEntry {
  model: string
  baseUrl?: string
  apiKey?: string
  size?: string
  /** 协议模式：'openai'（兼容 images 端点）| 'dashscope'（阿里云百炼 qwen-image 原生接口）。 */
  mode?: 'openai' | 'dashscope'
}

/** token-plan 文本生成子模型。 */
export interface TokenPlanTextEntry {
  id: string
  model: string
  label?: string
  capabilities?: string[]
}

/** token-plan 生图模型。 */
export interface TokenPlanImageEntry {
  model: string
  size?: string
}

/** token-plan 语音 / Realtime 模型（配置占位）。 */
export interface TokenPlanSimpleEntry {
  model: string
  label?: string
}

/** token-plan 配置：单独配置的阿里云聚合 API，一个 Key 下挂多类模型。 */
export interface TokenPlanEntry {
  apiKey?: string
  /** 专用域名（缺省 token-plan.cn-beijing.maas.aliyuncs.com）。 */
  baseUrl?: string
  /** 文本生成子模型（注册进模型路由）。 */
  textModels?: TokenPlanTextEntry[]
  /** 生图模型（DashScope 原生模式）。 */
  imageModels?: TokenPlanImageEntry[]
  /** 视频生成模型（首个用于 generate_video 工具）。 */
  videoModels?: TokenPlanSimpleEntry[]
  /** 语音模型（首个用于 text_to_speech 工具）。 */
  voiceModels?: TokenPlanSimpleEntry[]
  /** Realtime-Chatting 模型（配置占位）。 */
  realtimeModels?: TokenPlanSimpleEntry[]
}

export interface WebConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: string
  models?: SubModelEntry[]
  imageModel?: ImageModelEntry
  /** token-plan 配置（单独配置的阿里云聚合 API）。 */
  tokenPlan?: TokenPlanEntry
  /** 主模型支持多模态（图片输入）。 */
  multimodal?: boolean
  /** 自生长知识库配置（提供后启用 RAG 注入）。 */
  knowledge?: KnowledgeOptions
}

/** 自生长知识库配置。 */
export interface KnowledgeOptions {
  /** 是否启用（缺省 false）。 */
  enabled?: boolean
  /** embedding 配置（OpenAI 兼容 /embeddings；缺失时降级关键词检索）。 */
  embedding?: { baseUrl?: string; apiKey?: string; model?: string }
  /** 检索作用域（缺省 'global'）。 */
  scope?: 'global' | 'workspace'
  topK?: number
}

export interface MemoryEntry {
  id: string
  scope: 'user' | 'project' | 'auto'
  content: string
  tags?: string[]
  workspace?: string
  createdAt: number
  updatedAt: number
}

export const CAPABILITY_OPTIONS = ['code', 'reasoning', 'creative', 'analysis', 'fast', 'cheap', 'long-context', 'vision', 'general'] as const

/** 能力标签中文显示名（存储仍用英文 key）。 */
export const CAPABILITY_LABELS: Record<string, string> = {
  code: '代码',
  reasoning: '推理',
  creative: '创意',
  analysis: '分析',
  fast: '快速',
  cheap: '经济',
  'long-context': '长上下文',
  vision: '视觉',
  general: '通用',
}
