import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ImageModelOptions, KnowledgeOptions, KnowledgeService } from '@zhuxing/harness-bundle'
import type { HarnessImpl } from '@zhuxing/harness-kernel'
import type { SessionService } from '@zhuxing/harness-session'
import type { FileSessionStore } from '@zhuxing/harness-session'
import type { FileMemoryStore } from '@zhuxing/harness-memory'
import type { FileSkillStore } from '@zhuxing/harness-skills'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { AgentResult } from '@zhuxing/harness-agent'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import type { SpecManager } from '@zhuxing/harness-specs'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'

/** 运行时所需的最小配置形状（与 server.ts 的 WebConfig 对齐，避免循环依赖）。 */
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
  /** 自生长知识库配置（提供后启用 RAG 注入）。 */
  knowledge?: KnowledgeOptions
  /** MCP（Model Context Protocol）stdio server 配置（Claude Desktop / Cursor 的 mcpServers 形状）。 */
  mcpServers?: Record<string, unknown>
}

/**
 * 工作区根解析：config.workspace 优先；未配置时回退 process.cwd()。
 * 安装态本体由 launcher 从安装目录拉起服务（cwd 落在 HARNESS_ROOT 内），
 * 此时 cwd 并非用户项目——视为未配置并回退到用户主目录，
 * 避免项目目录索引 / 技能与知识的工作区级路径错误指向安装目录。
 */
export function resolveWorkspace(cfgWorkspace?: string): string {
  const explicit = cfgWorkspace?.trim()
  if (explicit) return resolve(explicit)
  const cwd = resolve(process.cwd())
  const root = process.env.HARNESS_ROOT
  if (root) {
    const rootAbs = resolve(root).toLowerCase()
    const lower = cwd.toLowerCase()
    if (lower === rootAbs || lower.startsWith(rootAbs + '\\') || lower.startsWith(rootAbs + '/')) return resolve(homedir())
  }
  return cwd
}

/** createHarness 返回的具体实现（含 dispose/events/pluginManager）。 */
type HarnessApp = HarnessImpl

/** 共享资源：一次性构建，全请求复用（对标 ChatGPT/OpenCode 的常驻运行时）。 */
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
        /** 协作式取消信号：内核会把它透传给 AgentLoop，用于「停止」真正停下服务端任务。 */
        signal?: AbortSignal
      },
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

/**
 * kernel.mjs（可热更新内核）的导出形状。
 * 外壳不静态依赖内核实现，仅通过运行时动态 import（带版本号破坏缓存）获取最新代码。
 */
interface KernelModule {
  createKernel: (opts: { config: RuntimeConfig; workspace: string; sessionDir: string }) => Promise<RuntimeResources>
  kernelSelfTest?: () => Promise<{ ok: boolean; detail: string }>
}

/** 定位内核模块文件：安装态在 <HARNESS_ROOT>/bin/kernel.mjs；开发态在仓库 dist-bin/kernel.mjs。 */
function kernelFilePath(): string {
  const root = process.env.HARNESS_ROOT
  if (root) return join(root, 'bin', 'kernel.mjs')
  // 开发态：harness.cjs 与 kernel.mjs 同级（编译产物 dist-bin/）；
  // 从源码运行（vitest/ts-node）时此处为 src/，需向上逐级查找 dist-bin/kernel.mjs。
  // 本包是 ESM（type: module），__dirname 在 ESM 作用域里不存在，故以 import.meta.url 为准；
  // 保留 __dirname 分支只为兼容被打成 CJS 的场景（typeof 取未声明标识符不会抛错）。
  const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
  const direct = join(here, 'kernel.mjs')
  if (existsSync(direct)) return direct
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'dist-bin', 'kernel.mjs')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return direct
}

/** 内核缓存指纹：版本号 + 文件 mtime。任一变化即触发重新加载，保证新代码无重启生效。 */
function currentKernelKey(): string {
  const p = kernelFilePath()
  let mtime = 0
  try {
    mtime = Math.round(statSync(p).mtimeMs)
  } catch {
    /* 内核文件缺失时以版本兜底，import 阶段会给出明确报错 */
  }
  const root = process.env.HARNESS_ROOT
  let version = '0.0.0'
  try {
    if (root) version = readFileSync(join(root, 'VERSION'), 'utf-8').trim() || version
  } catch {
    /* ignore */
  }
  version = version || (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__ || '0.0.0'
  return `${version}#${mtime}`
}

/**
 * 常驻运行时管理器：
 * - 服务启动时挂载一次内核（kernel.mjs 动态 import）；
 * - 配置变更时 `reload()` 重建（同一内核模块实例，重跑 createKernel）；
 * - 内核文件/版本变化时 `maybeReload()` 动态加载新内核，进程不重启即可用上新代码（热更新）。
 */
export class RuntimeManager {
  private resources?: RuntimeResources
  private sessionDir: string
  private workspace: string
  private kernelMod?: KernelModule
  private kernelKey = ''
  // 进行中的「长请求」计数（如 SSE 流式对话）：>0 时禁止重建运行时，
  // 否则 reload 会 dispose 掉仍在输出中的旧实例，导致进行中的对话被中断（页面/服务失联）。
  private activeUsers = 0
  // 有长请求占用时申请的重建会先挂起，等全部释放后再执行，避免中断对话。
  private pendingReload = false
  // 重建信号量：同一时刻仅允许一次重建，避免并发 dispose/createKernel 交错导致运行时损坏。
  private reloadPromise?: Promise<void>

  constructor(private getConfig: () => RuntimeConfig) {
    const cfg = getConfig()
    this.sessionDir = cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
    this.workspace = resolveWorkspace(cfg.workspace)
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

  /** 热更新检查：内核文件指纹（版本 + mtime）变化 → 重新加载新内核，无需重启。 */
  async maybeReload(): Promise<void> {
    const key = currentKernelKey()
    if (key !== this.kernelKey) await this.reload()
  }

  /**
   * 标记一个占用运行时的长请求开始（如 SSE 流式对话）。
   * 若此时有重建进行中，先等其完成，保证拿到的是最新且可用的运行时。
   */
  async acquire(): Promise<void> {
    if (this.reloadPromise) await this.reloadPromise
    this.activeUsers += 1
  }

  /** 长请求结束。若期间有挂起的重建，且当前已无请求占用，则立即执行（此时安全，不会中断任何对话）。 */
  release(): void {
    this.activeUsers = Math.max(0, this.activeUsers - 1)
    if (this.activeUsers === 0 && this.pendingReload) {
      this.pendingReload = false
      void this.runReload()
    }
  }

  async reload(): Promise<void> {
    // 有长请求（如正在输出的对话）占用运行时时不立即重建，否则会释放其正在使用的实例导致对话中断。
    // 改为挂起，待全部释放后再应用新配置/新内核。
    if (this.activeUsers > 0) {
      this.pendingReload = true
      return
    }
    await this.runReload()
  }

  /** 串行重建：同一时刻仅允许一次，复用进行中的重建 promise。 */
  private runReload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise
    this.reloadPromise = this.doReload().finally(() => {
      this.reloadPromise = undefined
    })
    return this.reloadPromise
  }

  private async doReload(): Promise<void> {
    const cfg = this.getConfig()
    this.sessionDir = cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
    this.workspace = resolveWorkspace(cfg.workspace)

    // 内核版本变化（或首次加载）→ 动态 import 新模块（`?v=` 破坏 ESM 缓存），否则复用已加载实例
    const key = currentKernelKey()
    if (key !== this.kernelKey || !this.kernelMod) {
      const url = `${pathToFileURL(kernelFilePath()).href}?v=${encodeURIComponent(key)}`
      const mod = (await import(url)) as KernelModule
      if (typeof mod.createKernel !== 'function') {
        throw new Error(`内核模块无效（缺少 createKernel）：${kernelFilePath()}`)
      }
      this.kernelMod = mod
      this.kernelKey = key
    }

    // 先构建新运行时，成功后再替换旧实例并释放之：保证重建窗口内 runtime.get() 拿到的始终是可用实例。
    // 由于 concurrent 请求在 acquire() 时会等待本次重建结束，因此此时不会有请求仍在使用旧实例。
    const next = await this.kernelMod.createKernel({
      config: cfg,
      workspace: this.workspace,
      sessionDir: this.sessionDir,
    })
    const prev = this.resources
    this.resources = next
    if (prev) await prev.app.dispose()
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
