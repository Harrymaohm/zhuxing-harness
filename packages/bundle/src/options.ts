/** bundle 的对外配置类型：基础 bundle 选项与知识库配置 / 运行时服务契约。 */
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import type { ModelConfigEntry, SelectorConfig } from '@zhuxing/harness-model-router'
import type { EmbeddingProvider, KnowledgeBase } from '@zhuxing/harness-knowledge'
import type { ImageModelOptions, TokenPlanOptions } from './token-plan.js'

export interface BaseBundleOptions {
  apiKey: string
  baseUrl?: string
  model: string
  workspace: string
  level: PermissionLevel
  systemPrompt?: string
  maxSteps?: number
  temperature?: number
  /** 目标校验器：模型给出最终答复且本回合调用过工具时，先校验目标是否真正达成；（缺省由内置模型自检兜底）。 */
  verifyGoal?: (ctx: import('@zhuxing/harness-agent').GoalVerifyContext) => Promise<import('@zhuxing/harness-agent').GoalVerifyResult>
  /** 目标校验失败后的最大补做循环次数（默认 2）。 */
  maxGoalVerify?: number
  /**
   * 指令精炼开关（默认开启）：每轮执行前先把用户的口语指令改写成任务书再执行。
   * 关掉即回到「用户原话直接交给内核」，适合追求极致响应速度或指令本身已足够结构化的场景。
   */
  refineInstruction?: boolean
  /** 多子模型配置：提供后启用模型路由与编排（主模型即编排模型）。 */
  models?: ModelConfigEntry[]
  /** 路由行为（失败降级 / 选择器权重）。 */
  router?: { fallback?: boolean; selector?: SelectorConfig }
  /** 显式指定子模型 id：Agent 循环直接使用该子模型（经路由器，保留监控与降级）。 */
  modelId?: string
  /** 生图模型配置：提供后注册 generate_image 工具（OpenAI 兼容 images 端点）。 */
  imageModel?: ImageModelOptions
  /** token-plan 配置：单独配置的阿里云聚合 API；文本子模型注册进路由，首图模型启用 generate_image。 */
  tokenPlan?: TokenPlanOptions
  /** 记忆存储路径（缺省 ~/.zhuxing-harness/memories.json）。 */
  memoryPath?: string
  /** 技能目录（缺省 ~/.zhuxing-harness/skills/ + 工作区/.harness/skills/）。 */
  skillsDirs?: string[]
  /**
   * MCP（Model Context Protocol）stdio server 配置，沿用 Claude Desktop / Cursor 的 `mcpServers` 形状：
   * `{ "<server>": { command, args?, env?, cwd? } }`。
   *
   * 安全语义（务必与自省文本一致）：接入某个 server 等于把它的能力并入你的 agent；server 是第三方代码，
   * 在**外部进程**里执行，本仓的路径沙箱**管不住它碰什么文件**。只接入你信任的 server；
   * `command: "npx"` 意味着每次可能执行不同版本的代码。详见 packages/bundle/src/self-knowledge.ts。
   */
  mcpServers?: Record<string, unknown>
  /** 知识库配置：提供后启用自生长知识库（文档上传 → 分块 → embedding → RAG 注入）。 */
  knowledge?: KnowledgeOptions
}

/** 自生长知识库配置。 */
export interface KnowledgeOptions {
  /** 是否启用（缺省 false）。 */
  enabled?: boolean
  /** 全局索引文件路径（缺省 ~/.zhuxing-harness/knowledge/index.json）。 */
  path?: string
  /** 工作区索引文件路径（可选，提供后合并工作区知识）。 */
  workspacePath?: string
  /** embedding 配置（OpenAI 兼容 /embeddings；缺失时降级关键词检索）。 */
  embedding?: { baseUrl?: string; apiKey?: string; model?: string }
  /** 检索作用域（缺省 'global'）。 */
  scope?: 'global' | 'workspace'
  topK?: number
  /** 当前已禁用的专业化包 id（这些包的知识文档不参与检索）。 */
  excludeSpecIds?: string[]
}

/** 运行时暴露的知识库服务（供 server API 与运行时读取）。 */
export interface KnowledgeService {
  /** 是否启用。 */
  enabled: boolean
  /** 全局知识库（~/.zhuxing-harness/knowledge）。 */
  global: KnowledgeBase
  /** 工作区知识库（可选）。 */
  workspace?: KnowledgeBase
  /** embedding provider（可能不可用）。 */
  provider: EmbeddingProvider
  /** 是否具备向量化能力。 */
  hasEmbedding: boolean
  /** 更新已禁用的专业化包 id（这些包的知识文档不参与检索）。 */
  setExcludedSpecs(ids: string[]): void
}
