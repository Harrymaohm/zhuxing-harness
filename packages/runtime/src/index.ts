import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHarness } from '@zhuxing/harness-kernel'
import { baseBundlePlugins, defaultSkillDirs } from '@zhuxing/harness-bundle'
import type { ImageModelOptions, KnowledgeOptions, KnowledgeService, McpClientManager } from '@zhuxing/harness-bundle'
import { defaultKnowledgeIndexPath } from '@zhuxing/harness-knowledge'
import { SpecManager } from '@zhuxing/harness-specs'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import type { SessionService } from '@zhuxing/harness-session'
import { FileSessionStore } from '@zhuxing/harness-session'
import { FileMemoryStore, defaultMemoryPath } from '@zhuxing/harness-memory'
import type { MemoryScope } from '@zhuxing/harness-memory'
import { FileSkillStore } from '@zhuxing/harness-skills'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { AgentResult } from '@zhuxing/harness-agent'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import { parseModelsConfig } from '@zhuxing/harness-model-router'

/**
 * 内核运行时配置（与 Web 外壳的 WebConfig 对齐，避免循环依赖）。
 * 这是「内核」的输入：决定一个对话/工作会话如何被组装。
 */
export interface RuntimeConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: PermissionLevel
  sessionDir?: string
  memoryPath?: string
  models?: ModelConfigEntry[] | string
  imageModel?: ImageModelOptions
  tokenPlan?: {
    apiKey?: string
    baseUrl?: string
    textModels?: ModelConfigEntry[]
    imageModels?: Array<{ model: string; size?: string }>
    videoModels?: Array<{ model: string; label?: string }>
    voiceModels?: Array<{ model: string; label?: string }>
    realtimeModels?: Array<{ model: string; label?: string }>
  }
  knowledge?: KnowledgeOptions
  /** 指令精炼：每轮执行前先把口语指令改写成任务书（默认开启，显式 false 关闭）。 */
  refineInstruction?: boolean
  /** MCP（Model Context Protocol）stdio server 配置（Claude Desktop / Cursor 的 mcpServers 形状）。 */
  mcpServers?: Record<string, unknown>
}

/** createHarness 返回的具体实现（含 dispose/events/pluginManager）。 */
type HarnessApp = ReturnType<typeof createHarness>

/** 共享资源：由内核构建，全请求复用（对标常驻运行时）。 */
export interface RuntimeResources {
  app: HarnessApp
  agent: {
    run: (
      input: string,
      sessionId?: string,
      opts?: {
        onToken?: (t: string) => void
        onReasoning?: (t: string) => void
        attachments?: Array<{ type: 'image'; dataUrl: string }>
        contextSessionId?: string
      },
    ) => Promise<AgentResult>
  }
  tools: ToolRegistry
  sessionService?: SessionService
  sessionStore: FileSessionStore
  memoryStore: FileMemoryStore
  skillStore: FileSkillStore
  knowledgeService?: KnowledgeService
  specManager: SpecManager
  startedAt: number
  configFingerprint: string
}

/** createKernel 输入：配置 + 外壳解析出的路径。 */
export interface KernelOptions {
  config: RuntimeConfig
  workspace: string
  sessionDir: string
}

/**
 * 解析 config.models。实现见 model-router 的 `parseModelsConfig`（全仓唯一一份）；
 * 这里保留原公开名以免破坏本包对外导出面。
 */
export function parseRuntimeModels(cfg: RuntimeConfig): ModelConfigEntry[] | undefined {
  return parseModelsConfig(cfg)
}

function fingerprint(cfg: RuntimeConfig): string {
  const { apiKey, imageModel, models, tokenPlan, ...rest } = cfg
  const maskedImage = imageModel ? { ...imageModel, apiKey: imageModel.apiKey ? '***' : undefined } : undefined
  const maskedModels = Array.isArray(models)
    ? models.map((m) => (m.apiKey ? { ...m, apiKey: '***' } : m))
    : undefined
  const maskedTokenPlan = tokenPlan ? { ...tokenPlan, apiKey: tokenPlan.apiKey ? '***' : undefined } : undefined
  // 知识库 embedding 的 key 也在配置里，必须一并掩码：该指纹会由 /api/health 原样回给调用方
  const maskedKnowledge = cfg.knowledge?.embedding?.apiKey
    ? { ...cfg.knowledge, embedding: { ...cfg.knowledge.embedding, apiKey: '***' } }
    : cfg.knowledge
  return JSON.stringify({
    ...rest,
    apiKey: apiKey ? '***' : undefined,
    imageModel: maskedImage,
    models: maskedModels,
    tokenPlan: maskedTokenPlan,
    knowledge: maskedKnowledge,
  })
}

/** 把调用方传入的知识库配置归一化为 bundle 所需的 KnowledgeOptions。 */
function buildKnowledgeOptions(knowledge: KnowledgeOptions | undefined, workspace: string): KnowledgeOptions | undefined {
  if (!knowledge?.enabled) return undefined
  return {
    ...knowledge,
    path: knowledge.path ?? defaultKnowledgeIndexPath(),
    workspacePath: knowledge.workspacePath ?? join(workspace, '.harness', 'knowledge', 'index.json'),
  }
}

/** 将已启用专业化包的内置知识文档同步到全局知识库（以 specId 隔离）。 */
async function syncSpecKnowledge(specManager: SpecManager, knowledgeService: KnowledgeService): Promise<void> {
  const globalStore = knowledgeService.global?.store
  if (!globalStore) return
  const specs = await specManager.list()
  for (const spec of specs.filter((s) => s.enabled)) {
    for (const old of await globalStore.list({ specId: spec.id })) {
      await globalStore.remove(old.id)
    }
    const dir = specManager.knowledgeDir(spec.id)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const full = join(dir, file)
      try {
        const st = await stat(full)
        if (!st.isFile()) continue
        const text = await readFile(full, 'utf-8')
        if (!text.trim()) continue
        await globalStore.addDocument({
          title: file.replace(/\.[^.]+$/, ''),
          source: `spec:${spec.id}`,
          scope: 'global',
          text,
          specId: spec.id,
          tags: spec.category ? [spec.category] : undefined,
        })
      } catch {
        /* 单文件解析失败时忽略 */
      }
    }
  }
}

/**
 * 构建内核运行时（热更新交换边界）。
 * Web 外壳常驻进程，通过动态 import 本模块（带版本号破坏缓存）在每次指令前加载最新内核。
 * 任何逻辑变更（agent / tools / prompt / bundle 行为）只改这一个模块即可无重启生效。
 */
export async function createKernel(options: KernelOptions): Promise<RuntimeResources> {
  const cfg = options.config
  const workspace = resolve(options.workspace)

  const app = createHarness({ logLevel: 'warn' })
  const sessionStore = new FileSessionStore(options.sessionDir)
  const memoryStore = new FileMemoryStore(cfg.memoryPath ?? defaultMemoryPath())
  const specManager = new SpecManager()
  const skillsDirs = [...defaultSkillDirs(workspace), ...specManager.enabledSkillDirs()]
  const skillStore = new FileSkillStore({ dirs: skillsDirs })

  for (const def of baseBundlePlugins({
    apiKey: cfg.apiKey ?? '',
    baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
    model: cfg.model ?? 'deepseek-v4-flash',
    workspace,
    level: (cfg.level ?? DEFAULT_PERMISSION_LEVEL) as PermissionLevel,
    models: parseRuntimeModels(cfg),
    imageModel: cfg.imageModel,
    tokenPlan: cfg.tokenPlan,
    memoryPath: cfg.memoryPath,
    knowledge: buildKnowledgeOptions(cfg.knowledge, workspace),
    skillsDirs,
    // 指令精炼默认开启；配置里显式写 false 才关闭
    refineInstruction: cfg.refineInstruction !== false,
    // MCP server 配置（stdio）：把外部 MCP 工具接入 agent（mcp__<server>__<tool>）。
    mcpServers: cfg.mcpServers,
  })) {
    const cfgOpt = def.name === 'harness-session' ? { storeDir: options.sessionDir } : undefined
    await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
  }

  // MCP 工具面就绪后再交出 agent：挂载本身不阻塞（启动不阻断），但会话应当看到配置好的工具面。
  // ready() 永不 reject（连接失败已隔离为逐 server 告警）。
  await app.services.get<McpClientManager>('mcp')?.ready()

  const agentRecord = app.pluginManager.get('harness-agent')
  if (!agentRecord) throw new Error('Agent 循环未就绪（bundle 挂载失败）')
  const agent = agentRecord.ctx.inject<RuntimeResources['agent']>('agent')
  const tools = app.pluginManager.get('harness-tools')?.ctx.inject<ToolRegistry>('tools')
  if (!tools) throw new Error('工具注册表未就绪（bundle 挂载失败）')
  const sessionService = app.pluginManager.get('harness-session')?.ctx.inject<SessionService>('sessionService')
  const knowledgeService = app.pluginManager.get('harness-knowledge')?.ctx.injectOptional<KnowledgeService>('knowledgeService')

  if (knowledgeService) {
    await syncSpecKnowledge(specManager, knowledgeService)
    knowledgeService.setExcludedSpecs(await specManager.disabledIds())
  }

  return {
    app,
    agent,
    tools,
    sessionService,
    sessionStore,
    memoryStore,
    skillStore,
    knowledgeService,
    specManager,
    startedAt: Date.now(),
    configFingerprint: fingerprint(cfg),
  }
}

/** 内核自检：创建后立即验证核心资源是否可用（供更新回滚健康检查）。 */
export async function kernelSelfTest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const resources = await createKernel({
      config: {},
      workspace: process.cwd(),
      sessionDir: join(homedir(), '.zhuxing-harness', 'sessions'),
    })
    const ok = !!resources.agent && !!resources.tools && !!resources.app
    await resources.app.dispose()
    return { ok, detail: ok ? '内核自检通过（agent/tools/app 就绪）' : '内核自检失败：核心资源缺失' }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export type { MemoryScope, SkillDefinition, ModelConfigEntry }
