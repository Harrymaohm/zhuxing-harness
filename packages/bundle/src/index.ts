/**
 * 基础 bundle：以插件形态提供沙箱、会话、工具、模型、Agent 循环。
 * 每一层都可被用户 patch 替换（无特权核心）。cli 与 web 共用。
 *
 * 本文件只做两件事：对外导出面 + 按固定顺序拼接各域插件工厂。
 * 顺序即依赖解析与启动顺序（后置插件的 inject 依赖前置插件的 provide），
 * 各域实现见 ./plugin-domains/，调整顺序前先确认域之间的 inject/provide 关系。
 */
import { resolve } from 'node:path'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { BaseBundleOptions } from './options.js'
import { agentPlugins } from './plugin-domains/agent.js'
import { coreToolsPlugins } from './plugin-domains/core-tools.js'
import { foundationPlugins } from './plugin-domains/foundation.js'
import { knowledgePlugins } from './plugin-domains/knowledge.js'
import { mcpPlugins } from './plugin-domains/mcp.js'
import { mediaPlugins } from './plugin-domains/media.js'
import { memoryPlugins } from './plugin-domains/memory.js'
import { modelRouterPlugins } from './plugin-domains/model-router.js'
import { selfKnowledgePlugins } from './plugin-domains/self-knowledge.js'
import { skillsPlugins } from './plugin-domains/skills.js'
import { telemetryPlugins } from './plugin-domains/telemetry.js'

/** 本体自省（辅助程序）：Agent 工具 harness_help 与 CLI 命令 harness introspect 共用同一实现。 */
export { currentVersion, renderSelfKnowledge, summarizePluginPermissions, SELF_KNOWLEDGE_TOPICS } from './self-knowledge.js'
export type { SelfKnowledgeInput, SelfKnowledgeTopic } from './self-knowledge.js'

/** 遥测（OpenTelemetry GenAI 约定）：span 形状、OTLP/JSON 编码、端点解析——供测试与外部复用。 */
export {
  AGENT_ID,
  AGENT_NAME,
  buildInferenceSpan,
  buildOtlpTracesRequest,
  buildToolSpan,
  detectProviderName,
  msToUnixNano,
  OtlpSpanExporter,
  parseOtlpHeaders,
  randomHex,
  resolveTelemetryConfig,
  SpanBuffer,
  TELEMETRY_SCOPE_NAME,
  telemetryPlugins,
  toOtlpAttributes,
  toOtlpAttributeValue,
} from './plugin-domains/telemetry.js'
export type {
  GenAiAttributeValue,
  GenAiSpan,
  InferenceSpanInput,
  OtlpResource,
  TelemetryConfig,
  TelemetryPluginDeps,
  TelemetryStats,
  ToolSpanInput,
} from './plugin-domains/telemetry.js'

/** 模型指标展示：区分「尚无采样」与「真实为 0」（cli 与 list_models 工具共用）。 */
export { formatModelMetricsLine, NO_SAMPLE_NOTE, toMetricsView } from './plugin-domains/model-router.js'
export type { ModelMetricsView } from './plugin-domains/model-router.js'

/**
 * MCP（Model Context Protocol）stdio 客户端：协议实现、配置解析、工具映射与多 server 编排。
 * 与遥测一样对外导出——测试、自省与评测（agent_harness_eval）都按真实生产代码使用同一实现。
 */
export {
  buildMcpToolDefinition,
  contentToText,
  DEFAULT_MCP_RESULT_MAX_BYTES,
  DEFAULT_MCP_TIMEOUTS,
  encodeMessage,
  isJsonRpcMessage,
  LineBuffer,
  mapToolCallResult,
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_TOOL_PREFIX,
  McpClient,
  McpClientManager,
  McpInputRequiredError,
  McpProtocolError,
  mcpToolName,
  parseLine,
  parseMcpServers,
  sanitizeToolName,
  StdioTransport,
  truncateByBytes,
} from './mcp/index.js'
export type {
  McpClientInfo,
  McpClientManagerOptions,
  McpClientOptions,
  McpConfigParseResult,
  McpServerConfig,
  McpServerStatus,
  McpTimeouts,
  McpToolDescriptor,
  McpTransportEra,
  StdioExitInfo,
  StdioTransportHandlers,
  StdioTransportOptions,
} from './mcp/index.js'

export type { BaseBundleOptions, KnowledgeOptions, KnowledgeService } from './options.js'
export type { ImageModelOptions, TokenPlanOptions } from './token-plan.js'
export { DEFAULT_TOKEN_PLAN_ORIGIN } from './token-plan.js'
export { defaultSkillDirs } from './plugin-domains/skills.js'
export { parseGitStatus, buildWorkspaceProfile } from './workspace-profile.js'
export { pickRecentBriefs } from './delivery-brief.js'

export function baseBundlePlugins(opts: BaseBundleOptions): PluginDefinition[] {
  const workspace = resolve(opts.workspace)

  return [
    ...foundationPlugins({ level: opts.level, workspace, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model }),
    // 遥测必须早于任何会派发事件的插件挂载：只在订阅侧工作，不 inject 任何服务
    // （baseUrl 仅用于按 GenAI 约定推断 Required 的 gen_ai.provider.name）
    ...telemetryPlugins({ baseUrl: opts.baseUrl }),
    ...coreToolsPlugins({ workspace }),
    // MCP 客户端紧随内建工具：它只 inject `tools`，把外部 MCP server 的工具注册为 mcp__<server>__<tool>。
    // 未配置 mcpServers 时不产生插件，默认装配与未接入 MCP 完全一致。
    ...mcpPlugins({ mcpServers: opts.mcpServers }),
    ...selfKnowledgePlugins({ workspace }),
    ...mediaPlugins({ workspace, apiKey: opts.apiKey, baseUrl: opts.baseUrl, imageModel: opts.imageModel, tokenPlan: opts.tokenPlan }),
    ...memoryPlugins({ workspace: opts.workspace, memoryPath: opts.memoryPath }),
    ...knowledgePlugins({ workspace, knowledge: opts.knowledge }),
    ...skillsPlugins({ workspace: opts.workspace, skillsDirs: opts.skillsDirs }),
    ...modelRouterPlugins({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      models: opts.models,
      router: opts.router,
      tokenPlan: opts.tokenPlan,
    }),
    ...agentPlugins({
      workspace: opts.workspace,
      model: opts.model,
      modelId: opts.modelId,
      systemPrompt: opts.systemPrompt,
      maxSteps: opts.maxSteps,
      temperature: opts.temperature,
      refineInstruction: opts.refineInstruction,
      verifyGoal: opts.verifyGoal,
      maxGoalVerify: opts.maxGoalVerify,
      memoryPath: opts.memoryPath,
    }),
  ]
}
