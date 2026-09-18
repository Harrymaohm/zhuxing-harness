import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { maskSecrets } from '@zhuxing/harness-kernel'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import { parseModelsConfig } from '@zhuxing/harness-model-router'
import type { KnowledgeOptions } from '@zhuxing/harness-bundle'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'

// ============ 配置读写（与 cli config-store 对齐，避免跨包内部 import） ============

export interface WebConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: PermissionLevel
  sessionDir?: string
  /** 多子模型配置（JSON 数组）。 */
  models?: ModelConfigEntry[] | string
  /** 生图模型配置（OpenAI 兼容 images 端点）。 */
  imageModel?: ImageModelConfig
  /** token-plan 配置：单独配置的阿里云聚合 API（一个 Key 下挂文本 / 生图 / 语音 / Realtime 多类模型）。 */
  tokenPlan?: TokenPlanConfig
  /** 主模型支持多模态（图片输入）。 */
  multimodal?: boolean
  /** 应用内更新源地址。 */
  updateUrl?: string
  /** 自生长知识库配置（提供后启用 RAG 注入）。 */
  knowledge?: KnowledgeOptions
  /** 指令精炼：每轮执行前先把口语指令改写成任务书再执行（默认开启，显式 false 关闭）。 */
  refineInstruction?: boolean
  /** MCP（Model Context Protocol）stdio server 配置（Claude Desktop / Cursor 的 mcpServers 形状）。 */
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

/** token-plan 配置（阿里云百炼聚合 API）。 */
export interface TokenPlanConfig {
  /** token-plan 专用 API Key。 */
  apiKey?: string
  /** 专用域名（缺省 token-plan.cn-beijing.maas.aliyuncs.com）。 */
  baseUrl?: string
  /** 文本生成子模型（注册进模型路由）。 */
  textModels?: ModelConfigEntry[]
  /** 生图模型（DashScope 原生模式）。 */
  imageModels?: Array<{ model: string; size?: string }>
  /** 视频生成模型（首个用于 generate_video 工具）。 */
  videoModels?: Array<{ model: string; label?: string }>
  /** 语音模型（首个用于 text_to_speech 工具）。 */
  voiceModels?: Array<{ model: string; label?: string }>
  /** Realtime-Chatting 模型（配置占位）。 */
  realtimeModels?: Array<{ model: string; label?: string }>
}

/** 生图模型配置。 */
export interface ImageModelConfig {
  /** OpenAI 兼容模型名（如 'wanx-v1' / 'dall-e-3'）。 */
  model: string
  /** images 端点基址（缺省回退主 baseUrl，需支持 /images/generations）。 */
  baseUrl?: string
  /** API Key（缺省回退主 apiKey）。 */
  apiKey?: string
  /** 默认尺寸（如 '1024x1024'）。 */
  size?: string
  /** 协议模式：'openai'（默认，兼容 images 端点）| 'dashscope'（阿里云百炼 qwen-image 原生接口）。 */
  mode?: 'openai' | 'dashscope'
}

export function webConfigPath(): string {
  return process.env.HARNESS_CONFIG ?? join(homedir(), '.zhuxing-harness', 'config.json')
}

export function loadWebConfig(): WebConfig {
  const p = webConfigPath()
  if (!existsSync(p)) return {}
  let raw: string
  try {
    // 去掉 UTF-8 BOM：记事本等编辑器保存的 JSON 常带 BOM，而 JSON.parse 会直接抛错，
    // 表现为「整份配置静默变成空」——apiKey/workspace/level 全丢，用户完全看不出原因。
    raw = readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')
  } catch {
    return {}
  }
  try {
    return JSON.parse(raw) as WebConfig
  } catch (err) {
    // 配置文件存在但解析失败：必须留下痕迹，不能装作「没配过」
    console.warn(`[harness] 配置文件解析失败，已按空配置继续：${p} —— ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

/** 会话目录：配置 → 环境变量 → 用户主目录默认。 */
export function webSessionDir(cfg: WebConfig): string {
  return cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
}

/** 解析 config.models（支持 JSON 字符串或数组）。 */
/**
 * 解析 config.models。实现见 model-router 的 `parseModelsConfig`（全仓唯一一份）；
 * 这里保留原公开名以免破坏本包对外导出面。
 */
export function parseWebModels(cfg: WebConfig): ModelConfigEntry[] | undefined {
  return parseModelsConfig(cfg)
}

/** GET /api/config 输出脱敏：主 apiKey、子模型 apiKey、生图 apiKey 均掩码。 */
export function maskWebConfig(cfg: WebConfig): WebConfig {
  const masked: WebConfig = { ...cfg, apiKey: cfg.apiKey ? maskSecrets(cfg.apiKey) : undefined }
  const models = parseWebModels(cfg)
  if (models) {
    masked.models = models.map((m) => (m.apiKey ? { ...m, apiKey: maskSecrets(m.apiKey) } : m))
  }
  if (cfg.imageModel?.apiKey) {
    masked.imageModel = { ...cfg.imageModel, apiKey: maskSecrets(cfg.imageModel.apiKey) }
  }
  if (cfg.tokenPlan?.apiKey) {
    masked.tokenPlan = { ...cfg.tokenPlan, apiKey: maskSecrets(cfg.tokenPlan.apiKey) }
  }
  if (cfg.knowledge?.embedding?.apiKey) {
    masked.knowledge = { ...cfg.knowledge, embedding: { ...cfg.knowledge.embedding, apiKey: maskSecrets(cfg.knowledge.embedding.apiKey) } }
  }
  return masked
}

export function saveWebConfig(cfg: WebConfig): string {
  const p = webConfigPath()
  mkdirSync(resolve(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return p
}
