import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHarness } from '@zhuxing/harness-kernel'
import { baseBundlePlugins, defaultSkillDirs } from '@zhuxing/harness-bundle'
import type { ImageModelOptions, KnowledgeOptions, KnowledgeService } from '@zhuxing/harness-bundle'
import { defaultKnowledgeIndexPath } from '@zhuxing/harness-knowledge'
import { SpecManager } from '@zhuxing/harness-specs'
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

/** 运行时所需的最小配置形状（与 server.ts 的 WebConfig 对齐，避免循环依赖）。 */
export interface RuntimeConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: 'read-only' | 'workspace-write' | 'danger-full-access'
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
  /** 自生长知识库配置（提供后启用 RAG 注入）。 */
  knowledge?: KnowledgeOptions
}

/** 解析 config.models（支持 JSON 字符串或数组）。 */
export function parseRuntimeModels(cfg: RuntimeConfig): ModelConfigEntry[] | undefined {
  const raw = cfg.models
  if (!raw) return undefined
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? (parsed as ModelConfigEntry[]) : undefined
  } catch {
    return undefined
  }
}

/** createHarness 返回的具体实现（含 dispose/events/pluginManager）。 */
type HarnessApp = ReturnType<typeof createHarness>

/** 共享资源：一次性构建，全请求复用（对标 ChatGPT/OpenCode 的常驻运行时）。 */
export interface RuntimeResources {
  app: HarnessApp
  agent: {
    run: (
      input: string,
      sessionId?: string,
      opts?: { onToken?: (t: string) => void; attachments?: Array<{ type: 'image'; dataUrl: string }>; contextSessionId?: string },
    ) => Promise<AgentResult>
  }
  tools: ToolRegistry
  sessionService?: SessionService
  sessionStore: FileSessionStore
  memoryStore: FileMemoryStore
  skillStore: FileSkillStore
  /** 知识库服务（调用方未启用知识库时为 undefined）。 */
  knowledgeService?: KnowledgeService
  /** 专业化能力包管理器（安装 / 启用 / 禁用 / 移除）。 */
  specManager: SpecManager
  /** 运行时启动时间戳。 */
  startedAt: number
  /** 当前配置指纹（配置变更后更新）。 */
  configFingerprint: string
}

function fingerprint(cfg: RuntimeConfig): string {
  const { apiKey, imageModel, models, tokenPlan, ...rest } = cfg
  const maskedImage = imageModel ? { ...imageModel, apiKey: imageModel.apiKey ? '***' : undefined } : undefined
  const maskedModels = Array.isArray(models)
    ? models.map((m) => (m.apiKey ? { ...m, apiKey: '***' } : m))
    : undefined
  const maskedTokenPlan = tokenPlan ? { ...tokenPlan, apiKey: tokenPlan.apiKey ? '***' : undefined } : undefined
  return JSON.stringify({
    ...rest,
    apiKey: apiKey ? '***' : undefined,
    imageModel: maskedImage,
    models: maskedModels,
    tokenPlan: maskedTokenPlan,
  })
}

/**
 * 把调用方传入的知识库配置归一化为 bundle 所需的 KnowledgeOptions。
 * 未启用时返回 undefined（bundle 跳过 harness-knowledge 插件）。
 */
function buildKnowledgeOptions(
  knowledge: KnowledgeOptions | undefined,
  workspace: string,
): KnowledgeOptions | undefined {
  if (!knowledge?.enabled) return undefined
  return {
    ...knowledge,
    path: knowledge.path ?? defaultKnowledgeIndexPath(),
    workspacePath: knowledge.workspacePath ?? join(workspace, '.harness', 'knowledge', 'index.json'),
  }
}

/**
 * 将已启用专业化包的内置知识文档同步到全局知识库（以 specId 隔离）。
 * 已启用包：清旧 → 重新入库；已禁用包：保留文档但通过 setExcludedSpecs 排除检索。
 * 知识库未启用（knowledgeService 为 undefined）时不做任何事。
 */
async function syncSpecKnowledge(specManager: SpecManager, knowledgeService: KnowledgeService): Promise<void> {
  const globalStore = knowledgeService.global?.store
  if (!globalStore) return
  const specs = await specManager.list()
  for (const spec of specs.filter((s) => s.enabled)) {
    // 清掉该包旧的已入库文档，避免重复累积
    for (const old of await globalStore.list({ specId: spec.id })) {
      await globalStore.remove(old.id)
    }
    const dir = specManager.knowledgeDir(spec.id)
    let files: string[] = []
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
        /* 单文件解析失败时忽略，不影响其余文档 */
      }
    }
  }
}

/**
 * 常驻运行时管理器：服务启动时挂载一次 bundle，
 * 提供 agent / tools / session / memory / skills 共享实例与配置热重载。
 */
export class RuntimeManager {
  private resources?: RuntimeResources
  private sessionDir: string
  private workspace: string

  constructor(private getConfig: () => RuntimeConfig) {
    const cfg = getConfig()
    this.sessionDir = cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
    this.workspace = resolve(cfg.workspace ?? process.cwd())
  }

  get sessionDirectory(): string {
    return this.sessionDir
  }

  get workspacePath(): string {
    return this.workspace
  }

  async init(): Promise<void> {
    await this.reload()
  }

  get startedAt(): number {
    return this.resources?.startedAt ?? Date.now()
  }

  get fingerprint(): string {
    return this.resources?.configFingerprint ?? ''
  }

  async reload(): Promise<void> {
    const cfg = this.getConfig()
    this.sessionDir = cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
    this.workspace = resolve(cfg.workspace ?? process.cwd())

    if (this.resources) {
      await this.resources.app.dispose()
      this.resources = undefined
    }

    const app = createHarness({ logLevel: 'warn' })
    const sessionStore = new FileSessionStore(this.sessionDir)
    const memoryStore = new FileMemoryStore(cfg.memoryPath ?? defaultMemoryPath())
    const specManager = new SpecManager()
    // 技能目录：默认目录 + 已启用专业化包的 skills/（专业化技能随包启用）
    const skillsDirs = [...defaultSkillDirs(this.workspace), ...specManager.enabledSkillDirs()]
    const skillStore = new FileSkillStore({ dirs: skillsDirs })

    for (const def of baseBundlePlugins({
      apiKey: cfg.apiKey ?? '',
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model ?? 'deepseek-v4-flash',
      workspace: this.workspace,
      level: (cfg.level ?? 'danger-full-access') as PermissionLevel,
      models: parseRuntimeModels(cfg),
      imageModel: cfg.imageModel,
      tokenPlan: cfg.tokenPlan,
      memoryPath: cfg.memoryPath,
      knowledge: buildKnowledgeOptions(cfg.knowledge, this.workspace),
      skillsDirs,
    })) {
      const cfgOpt = def.name === 'harness-session' ? { storeDir: this.sessionDir } : undefined
      await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
    }

    const agentRecord = app.pluginManager.get('harness-agent')
    if (!agentRecord) throw new Error('Agent 循环未就绪（bundle 挂载失败）')
    const agent = agentRecord.ctx.inject<RuntimeResources['agent']>('agent')
    const tools = app.pluginManager.get('harness-tools')?.ctx.inject<ToolRegistry>('tools')
    if (!tools) throw new Error('工具注册表未就绪（bundle 挂载失败）')
    const sessionService = app.pluginManager.get('harness-session')?.ctx.inject<SessionService>('sessionService')
    const knowledgeService = app.pluginManager.get('harness-knowledge')?.ctx.injectOptional<KnowledgeService>('knowledgeService')

    // 专业化知识入库：已启用包的内置文档同步到全局知识库；禁用包隔离出检索
    if (knowledgeService) {
      await syncSpecKnowledge(specManager, knowledgeService)
      knowledgeService.setExcludedSpecs(await specManager.disabledIds())
    }

    this.resources = {
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

  get(): RuntimeResources {
    if (!this.resources) throw new Error('RuntimeManager 未初始化')
    return this.resources
  }

  /** 校验 session 存在（复用）；不存在则忽略。 */
  async resolveSessionId(sessionId: string | undefined): Promise<string | undefined> {
    if (!sessionId || !this.resources) return sessionId
    const ids = await this.resources.sessionStore.listSessions()
    return ids.includes(sessionId) ? sessionId : undefined
  }

  async dispose(): Promise<void> {
    if (this.resources) {
      await this.resources.app.dispose()
      this.resources = undefined
    }
  }
}

export type { MemoryScope, SkillDefinition, ModelConfigEntry }
