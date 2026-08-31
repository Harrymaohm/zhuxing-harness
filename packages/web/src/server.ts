import http from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { maskSecrets } from '@zhuxing/harness-kernel'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import type { MemoryScope } from '@zhuxing/harness-memory'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import { normalizeSkillDefinition, parseSkill, validateSkillDefinition } from '@zhuxing/harness-skills'
import { defaultSkillDirs } from '@zhuxing/harness-bundle'
import type { KnowledgeOptions, KnowledgeService } from '@zhuxing/harness-bundle'
import { extractText } from '@zhuxing/harness-knowledge'
import { SpecManager } from '@zhuxing/harness-specs'
import { RuntimeManager } from './runtime.js'

// ============ 配置读写（与 cli config-store 对齐，避免跨包内部 import） ============

export interface WebConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: 'read-only' | 'workspace-write' | 'danger-full-access'
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

/** token-plan 文本生成模型（上游 /compatible-mode/v1/models 读取失败时的内置回退清单，与官方文档对齐）。 */
const TOKEN_PLAN_TEXT_BUILTIN: Array<{ id: string; model: string; label?: string; capabilities?: string[] }> = [
  { id: 'qwen3.8-max', model: 'qwen3.8-max', label: 'Qwen3.8 Max', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'qwen3.7-max', model: 'qwen3.7-max', label: 'Qwen3.7 Max', capabilities: ['reasoning', 'general'] },
  { id: 'qwen3.7-plus', model: 'qwen3.7-plus', label: 'Qwen3.7 Plus', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'qwen3.6-flash', model: 'qwen3.6-flash', label: 'Qwen3.6 Flash', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'glm-5.2', model: 'glm-5.2', label: 'GLM-5.2', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-pro', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-pro-0813', model: 'deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro 0813', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-flash-0731', model: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', capabilities: ['general'] },
]

/** token-plan 多模态模型清单（无上游列表接口，按官方文档静态维护）。 */
const TOKEN_PLAN_BUILTIN = {
  imageModels: [{ model: 'qwen-image-2.0' }, { model: 'qwen-image-2.0-pro' }, { model: 'qwen-image-3.0-pro' }, { model: 'wan2.7-image' }, { model: 'wan2.7-image-pro' }],
  videoModels: [
    { model: 'happyhorse-1.1-t2v', label: '文生视频' },
    { model: 'happyhorse-1.1-i2v', label: '图生视频' },
    { model: 'happyhorse-1.1-r2v', label: '视频重绘' },
  ],
  voiceModels: [{ model: 'qwen-audio-3.0-tts-plus', label: '语音合成' }],
  realtimeModels: [{ model: 'qwen-audio-3.0-realtime-plus', label: '实时语音对话' }],
}

/** 从模型名启发式推断能力标签（上游 /models 只给 id，无 capabilities）。 */
function inferTextCaps(model: string): string[] {
  const caps = new Set<string>(['general'])
  const name = model.toLowerCase()
  if (name.includes('qwen') || name.includes('glm') || name.includes('reason') || name.includes('-r1')) caps.add('reasoning')
  if (name.includes('image') || name.includes('vision')) caps.add('vision')
  return [...caps]
}

/** 请求 token-plan 兼容路径的 /models（OpenAI 兼容结构），返回文本生成模型列表。 */
async function fetchTokenPlanTextModels(
  baseUrl: string,
  apiKey: string,
): Promise<Array<{ id: string; model: string; label?: string }>> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    origin = baseUrl.replace(/\/+$/, '')
  }
  const url = `${origin}/compatible-mode/v1/models`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`上游模型列表获取失败（HTTP ${res.status}）`)
  const payload = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> }
  const list = payload.data ?? payload.models ?? []
  return list
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id as string, model: m.id as string, label: m.name ?? m.id }))
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
  try {
    const p = webConfigPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as WebConfig
  } catch {
    return {}
  }
}

/** 会话目录：配置 → 环境变量 → 用户主目录默认。 */
export function webSessionDir(cfg: WebConfig): string {
  return cfg.sessionDir ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
}

/** 解析 config.models（支持 JSON 字符串或数组）。 */
export function parseWebModels(cfg: WebConfig): ModelConfigEntry[] | undefined {
  const raw = cfg.models
  if (!raw) return undefined
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? (parsed as ModelConfigEntry[]) : undefined
  } catch {
    return undefined
  }
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

// ============ 版本 ============

function packageVersion(): string {
  const injected = (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__
  if (injected) return injected
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = packageVersion()

// ============ SSE / JSON 工具 ============

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function sseEnd(res: ServerResponse): void {
  res.write('event: done\ndata: {}\n\n')
  res.end()
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

// ============ 服务器 ============

export interface WebServerOptions {
  port?: number
  host?: string
  uiDir?: string
}

export interface WebServerHandle {
  server: Server
  port: number
  url: string
  /** 释放常驻运行时（进程退出时调用一次）。 */
  dispose: () => Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** Web UI 静态目录默认解析：源码态为包内 dist-ui；安装态可用 HARNESS_WEB_UI_DIR 覆盖。 */
function defaultUiDir(): string {
  const fromEnv = process.env.HARNESS_WEB_UI_DIR
  if (fromEnv) return resolve(fromEnv)
  try {
    return resolve(fileURLToPath(new URL('../dist-ui', import.meta.url)))
  } catch {
    return resolve(process.cwd(), 'dist-ui')
  }
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const uiDir = options.uiDir ?? defaultUiDir()

  // 常驻运行时：启动时挂载一次 bundle，全请求复用（对标 ChatGPT/OpenCode）
  const runtime = new RuntimeManager(() => loadWebConfig())
  await runtime.init()
  const staticAssets = loadStaticAssets(uiDir)
  // 本地认证：存在 HARNESS_ACCESS_TOKEN 时，API 校验 X-Harness-Token（安装态由启动器注入）
  const accessToken = process.env.HARNESS_ACCESS_TOKEN ?? ''

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, runtime, staticAssets, accessToken)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 0, host, () => resolveListen())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
  return {
    server,
    port,
    url: `http://${host}:${port}`,
    dispose: () => runtime.dispose(),
  }
}

/** API 是否免认证（SPA 入口 / 静态资源 / health / bootstrap 放行；token 只保护 API）。 */
function isPublicPath(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/api/health' || path === '/api/bootstrap' || path === '/harness.ico')) return true
  if (path.startsWith('/assets/')) return true
  return false
}

// ============ 应用内更新 ============

/** 安装根目录（安装态由 harness.cmd 注入 HARNESS_ROOT；开发态为 null）。 */
function webInstallRoot(): string | null {
  return process.env.HARNESS_ROOT ?? null
}

/** 当前版本：优先读安装目录 VERSION，否则回退构建注入版本。 */
function webCurrentVersion(): string {
  const root = webInstallRoot()
  if (root) {
    try {
      const v = readFileSync(join(root, 'VERSION'), 'utf-8').trim()
      if (v) return v
    } catch {
      /* ignore */
    }
  }
  return VERSION
}

function compareSemverLocal(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function resolveUpdateUrl(cfg: WebConfig): string {
  return (process.env.HARNESS_UPDATE_URL ?? cfg.updateUrl ?? '').trim()
}

interface RemoteManifest {
  latestVersion: string
  releaseNotes?: string
}

async function fetchRemoteManifest(url: string): Promise<RemoteManifest> {
  const manifestUrl = url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`获取更新清单失败（HTTP ${res.status}）`)
  return (await res.json()) as RemoteManifest
}

/** 后台独立进程执行更新（避免自我更新停止当前服务）。 */
function spawnUpdate(root: string, extraArgs: string[]): void {
  const node = join(root, 'node', 'node.exe')
  const cli = join(root, 'bin', 'harness.cjs')
  const child = spawn(node, [cli, 'update', ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HARNESS_ROOT: root },
  })
  child.unref()
}

/** 弹出本地目录选择器（Windows PowerShell FolderBrowserDialog），返回选中路径；取消或失败返回空。 */
function pickFolderDialog(initialDir?: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const psInit = initialDir ? `$d.SelectedPath = '${initialDir.replace(/'/g, "''")}';` : ''
    const script =
      `Add-Type -AssemblyName System.Windows.Forms;` +
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog;` +
      `$d.Description = '选择工作区目录';` +
      `$d.ShowNewFolderButton = $true;` +
      psInit +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }`
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf-8')))
    child.on('close', () => resolvePromise(out.trim()))
    child.on('error', () => resolvePromise(''))
  })
}

async function handleRequest(
  req: http.IncomingMessage,
  res: ServerResponse,
  runtime: RuntimeManager,
  staticAssets: Map<string, { type: string; data: Buffer; etag: string }>,
  accessToken: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  // 认证中间件：token 配置后，除公开路径外一律校验
  if (accessToken && !isPublicPath(req.method ?? 'GET', path)) {
    if (req.headers['x-harness-token'] !== accessToken) {
      json(res, 401, { error: '未授权：缺少或错误的访问令牌' })
      return
    }
  }

  try {
    if (req.method === 'GET' && path === '/api/bootstrap') {
      json(res, 200, { token: accessToken || undefined, version: VERSION })
      return
    }
    if (req.method === 'GET' && path === '/api/health') {
      const r = runtime.get()
      json(res, 200, {
        ok: true,
        version: VERSION,
        uptimeMs: Date.now() - runtime.startedAt,
        configFingerprint: runtime.fingerprint,
        listenerCount: r.app.events.listenerCount,
      })
      return
    }
    if (req.method === 'GET' && path === '/harness.ico') {
      const iconPath = process.env.HARNESS_ICON_PATH ?? fileURLToPath(new URL('../../../kk6zc-wyj96-001.ico', import.meta.url))
      if (!existsSync(iconPath)) {
        json(res, 404, { error: '图标不存在' })
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' })
      res.end(readFileSync(iconPath))
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      const cfg = loadWebConfig()
      json(res, 200, maskWebConfig(cfg))
      return
    }
    if (req.method === 'POST' && path === '/api/config') {
      const body = (await readJsonBody(req)) as Partial<WebConfig>
      const prev = loadWebConfig()
      const allowed: Partial<WebConfig> = {}
      for (const key of ['apiKey', 'baseUrl', 'model', 'workspace', 'level', 'sessionDir', 'multimodal', 'knowledge'] as const) {
        if (body[key] !== undefined) (allowed as Record<string, unknown>)[key] = body[key]
      }
      // 子模型按 id 合并：未提交的 apiKey（前端脱敏后置空）保留旧值
      if (body.models !== undefined) {
        const prevModels = parseWebModels(prev) ?? []
        const nextModels = (Array.isArray(body.models) ? body.models : []).map((m) => {
          const old = prevModels.find((p) => p.id === m.id)
          return m.apiKey === undefined && old?.apiKey ? { ...m, apiKey: old.apiKey } : m
        })
        allowed.models = nextModels
      }
      // 生图模型：apiKey 未提交时保留旧值
      if (body.imageModel !== undefined) {
        const prevImg = prev.imageModel
        allowed.imageModel =
          body.imageModel.apiKey === undefined && prevImg?.apiKey ? { ...body.imageModel, apiKey: prevImg.apiKey } : body.imageModel
      }
      // token-plan：apiKey 未提交时保留旧值
      if (body.tokenPlan !== undefined) {
        const prevTp = prev.tokenPlan
        allowed.tokenPlan =
          body.tokenPlan.apiKey === undefined && prevTp?.apiKey ? { ...body.tokenPlan, apiKey: prevTp.apiKey } : body.tokenPlan
      }
      // 知识库：embedding apiKey 未提交（或为掩码占位）时保留旧值
      if (body.knowledge !== undefined) {
        const prevKb = prev.knowledge
        const kb = body.knowledge
        const maskedKb = !!kb.embedding?.apiKey && kb.embedding.apiKey.includes('***')
        allowed.knowledge =
          maskedKb || (kb.embedding?.apiKey === undefined && !!prevKb?.embedding?.apiKey)
            ? { ...kb, embedding: { ...(prevKb?.embedding ?? {}), ...kb.embedding, apiKey: prevKb?.embedding?.apiKey } }
            : kb
      }
      const merged = { ...prev, ...allowed }
      const p = saveWebConfig(merged)
      // 热重载：配置变更后重建运行时（全量 re-mount，本地单机稳妥优先）
      await runtime.reload()
      json(res, 200, { ok: true, path: p })
      return
    }
    // ===== 工作区选择 =====
    // 一键生成临时工作区目录（无需真实项目目录）
    if (req.method === 'POST' && path === '/api/workspace/temp') {
      const base = join(homedir(), '.zhuxing-harness', 'workspaces')
      mkdirSync(base, { recursive: true })
      const name = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const dir = join(base, name)
      mkdirSync(dir, { recursive: true })
      json(res, 200, { path: dir })
      return
    }
    // 弹出本地目录选择器（Windows FolderBrowserDialog）
    if (req.method === 'POST' && path === '/api/workspace/pick') {
      const body = (await readJsonBody(req)) as { initial?: string }
      const picked = await pickFolderDialog(body.initial)
      if (!picked) {
        json(res, 200, { canceled: true })
        return
      }
      json(res, 200, { path: picked })
      return
    }
    // 从上游读取 token-plan 模型清单：文本模型走 OpenAI 兼容 /models，多模态模型用官方内置清单
    if (req.method === 'GET' && path === '/api/token-plan/models') {
      const cfg = loadWebConfig()
      const tp = cfg.tokenPlan
      if (!tp?.apiKey) {
        json(res, 400, { error: '未配置 token-plan API Key' })
        return
      }
      const baseUrl = tp.baseUrl ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com'
      try {
        const textModels = await fetchTokenPlanTextModels(baseUrl, tp.apiKey)
        json(res, 200, {
          textModels: textModels.map((m) => ({ ...m, capabilities: inferTextCaps(m.model) })),
          builtin: TOKEN_PLAN_BUILTIN,
        })
      } catch (err) {
        json(res, 200, {
          textModels: TOKEN_PLAN_TEXT_BUILTIN,
          builtin: TOKEN_PLAN_BUILTIN,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      const store = runtime.get().sessionStore
      const ids = await store.listSessions()
      const spaceFilter = url.searchParams.get('spaceId') ?? undefined
      const archivedFilter = url.searchParams.get('archived')
      const sessions = []
      for (const id of ids) {
        const events = await store.list(id)
        const first = events[0]
        const meta = await store.getMeta(id)
        const archived = meta?.archived === true
        if (spaceFilter !== undefined && (meta?.spaceId ?? '') !== spaceFilter) continue
        if (archivedFilter === 'true' && !archived) continue
        if (archivedFilter === 'false' && archived) continue
        sessions.push({
          id,
          eventCount: events.length,
          createdAt: first ? first.ts : undefined,
          preview: first?.payload ? String((first.payload as { content?: string }).content ?? '').slice(0, 80) : '',
          title: meta?.title ?? (first?.payload && typeof first.payload === 'object' ? String((first.payload as { title?: string }).title ?? '') : ''),
          parentId: meta?.parentId,
          forkPointEventId: meta?.forkPointEventId,
          spaceId: meta?.spaceId,
          archived,
          archivedAt: meta?.archivedAt,
        })
      }
      sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      json(res, 200, { sessions })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/archive')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/archive'.length))
      const store = runtime.get().sessionStore
      await store.archiveSession(id)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/unarchive')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/unarchive'.length))
      const store = runtime.get().sessionStore
      await store.unarchiveSession(id)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && path === '/api/spaces') {
      const store = runtime.get().sessionStore
      const spaces = await store.listSpaces()
      const defaultCount = (await store.listSessionsWithMeta()).filter((s) => !s.meta?.spaceId).length
      json(res, 200, { spaces, defaultSpace: { id: '', title: '默认空间', sessionCount: defaultCount } })
      return
    }
    if (req.method === 'POST' && path === '/api/spaces') {
      const body = (await readJsonBody(req)) as { title?: string }
      const store = runtime.get().sessionStore
      const space = await store.createSpace(body.title ?? '')
      json(res, 200, { ok: true, space })
      return
    }
    if (req.method === 'PATCH' && path.startsWith('/api/spaces/')) {
      const id = decodeURIComponent(path.slice('/api/spaces/'.length))
      const body = (await readJsonBody(req)) as { title?: string }
      const store = runtime.get().sessionStore
      await store.renameSpace(id, body.title ?? '')
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/spaces/')) {
      const id = decodeURIComponent(path.slice('/api/spaces/'.length))
      if (!id) {
        json(res, 400, { error: '默认空间不可删除' })
        return
      }
      const store = runtime.get().sessionStore
      await store.removeSpace(id)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/fork')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/fork'.length))
      const body = (await readJsonBody(req)) as { eventId?: string }
      const store = runtime.get().sessionStore
      const childId = await store.forkSession(id, body.eventId)
      json(res, 200, { ok: true, sessionId: childId })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/merge')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length, -'/merge'.length))
      const body = (await readJsonBody(req)) as { childId?: string; summary?: string }
      if (!body.childId) {
        json(res, 400, { error: '缺少 childId' })
        return
      }
      const store = runtime.get().sessionStore
      await store.mergeInto(id, body.childId, body.summary)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const store = runtime.get().sessionStore
      await store.remove(id)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'PATCH' && path.startsWith('/api/sessions/') && !path.endsWith('/events')) {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const body = (await readJsonBody(req)) as { title?: string }
      const title = String(body.title ?? '').trim().slice(0, 120)
      if (!title) {
        json(res, 400, { error: '会话标题不能为空' })
        return
      }
      const store = runtime.get().sessionStore
      await store.rename(id, title)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.endsWith('/events')) {
      const id = path.slice('/api/sessions/'.length, -'/events'.length)
      const store = runtime.get().sessionStore
      const events = await store.list(id)
      json(res, 200, { sessionId: id, events })
      return
    }
    if (req.method === 'GET' && path === '/api/models') {
      const cfg = loadWebConfig()
      const models = parseWebModels(cfg)
      json(res, 200, {
        models: models ?? [],
        main: cfg.model ?? 'deepseek-v4-flash',
      })
      return
    }
    if (req.method === 'POST' && path === '/api/chat') {
      const body = (await readJsonBody(req)) as { message?: string; sessionId?: string; attachments?: Array<{ type: 'image'; dataUrl: string }>; spaceId?: string; contextSessionId?: string }
      await handleChat(res, body.message ?? '', body.sessionId, runtime, body.attachments, body.spaceId, body.contextSessionId)
      return
    }
    // ===== 应用内更新 =====
    if (req.method === 'GET' && path === '/api/update/check') {
      const cfg = loadWebConfig()
      const url = resolveUpdateUrl(cfg)
      const current = webCurrentVersion()
      if (!url) {
        json(res, 200, { currentVersion: current, latestVersion: '', hasUpdate: false, error: '未配置更新源' })
        return
      }
      try {
        const manifest = await fetchRemoteManifest(url)
        json(res, 200, {
          currentVersion: current,
          latestVersion: manifest.latestVersion,
          hasUpdate: compareSemverLocal(manifest.latestVersion, current) > 0,
          releaseNotes: manifest.releaseNotes,
        })
      } catch (err) {
        json(res, 200, { currentVersion: current, latestVersion: '', hasUpdate: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/update') {
      const root = webInstallRoot()
      if (!root) {
        json(res, 400, { ok: false, error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' })
        return
      }
      const url = resolveUpdateUrl(loadWebConfig())
      if (!url) {
        json(res, 400, { ok: false, error: '未配置更新源' })
        return
      }
      spawnUpdate(root, ['--url', url])
      json(res, 200, { ok: true, message: '更新已在后台启动' })
      return
    }
    if (req.method === 'POST' && path === '/api/update/install') {
      const root = webInstallRoot()
      if (!root) {
        json(res, 400, { ok: false, error: '仅安装版支持更新（未检测到 HARNESS_ROOT）' })
        return
      }
      const body = (await readJsonBody(req)) as { data?: string; name?: string }
      if (!body.data) {
        json(res, 400, { ok: false, error: '缺少增量包数据' })
        return
      }
      const buf = Buffer.from(body.data, 'base64')
      const zipPath = join(tmpdir(), `harness-update-${Date.now()}-${body.name ?? 'update.zip'}`)
      writeFileSync(zipPath, buf)
      spawnUpdate(root, ['--file', zipPath])
      json(res, 200, { ok: true, message: '更新已在后台启动' })
      return
    }
    if (req.method === 'GET' && path === '/api/files/preview') {
      const requested = url.searchParams.get('path')
      if (!requested) {
        json(res, 400, { error: '缺少文件路径' })
        return
      }
      const cfg = loadWebConfig()
      const workspaceRoot = resolve(cfg.workspace ?? process.cwd())
      const filePath = resolve(workspaceRoot, requested)
      // danger-full-access（默认）下允许预览任意本地文件；其余级别限定在工作区内
      const unrestricted = (cfg.level ?? 'danger-full-access') === 'danger-full-access'
      if (
        !unrestricted &&
        filePath !== workspaceRoot &&
        !filePath.startsWith(`${workspaceRoot}${process.platform === 'win32' ? '\\' : '/'}`)
      ) {
        json(res, 403, { error: '只能预览工作区内的文件' })
        return
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        json(res, 404, { error: '文件不存在' })
        return
      }
      const stat = statSync(filePath)
      // raw=1：按 MIME 流式返回原始二进制（PDF 等二进制文件，避免 utf-8 乱码）
      if (url.searchParams.get('raw') === '1') {
        if (stat.size > 20 * 1024 * 1024) {
          json(res, 413, { error: '文件过大（上限 20 MB）' })
          return
        }
        const mime = (extname(filePath).toLowerCase()) === '.pdf' ? 'application/pdf' : 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
        res.end(readFileSync(filePath))
        return
      }
      if (stat.size > 2 * 1024 * 1024) {
        json(res, 413, { error: '文件过大，暂不支持预览（上限 2 MB）' })
        return
      }
      const content = readFileSync(filePath, 'utf-8')
      json(res, 200, { path: requested, content, size: stat.size })
      return
    }
    // 拖拽文件/文件夹：浏览器拿不到本地绝对路径时，上传内容到临时 drops 目录生成链接
    if (req.method === 'POST' && path === '/api/files/upload') {
      const body = (await readJsonBody(req)) as { name?: string; data?: string }
      if (!body.name || typeof body.data !== 'string') {
        json(res, 400, { error: '缺少文件名或内容' })
        return
      }
      let buf: Buffer
      try {
        buf = Buffer.from(body.data, 'base64')
      } catch {
        json(res, 400, { error: '内容不是有效的 base64' })
        return
      }
      if (buf.length > 50 * 1024 * 1024) {
        json(res, 413, { error: '文件过大（上限 50 MB）' })
        return
      }
      const dropDir = join(homedir(), '.zhuxing-harness', 'drops')
      mkdirSync(dropDir, { recursive: true })
      const safe = body.name.replace(/[\\/:*?"<>|]/g, '_')
      const target = join(dropDir, `${Date.now()}-${safe}`)
      writeFileSync(target, buf)
      json(res, 200, { ok: true, path: target })
      return
    }
    // ===== 记忆管理 =====
    if (req.method === 'GET' && path === '/api/memory') {
      const store = runtime.get().memoryStore
      const scope = url.searchParams.get('scope') as MemoryScope | null
      const q = url.searchParams.get('q') ?? undefined
      const entries = await store.list({ scope: scope ?? undefined, q })
      json(res, 200, { entries })
      return
    }
    if (req.method === 'POST' && path === '/api/memory') {
      const body = (await readJsonBody(req)) as { content?: string; scope?: string; tags?: string[]; workspace?: string }
      const content = (body.content ?? '').trim()
      if (!content) {
        json(res, 400, { error: '缺少 content' })
        return
      }
      const store = runtime.get().memoryStore
      const entry = await store.add({
        scope: (body.scope as MemoryScope) ?? 'auto',
        content,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
      })
      json(res, 200, { entry })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/memory/')) {
      const id = decodeURIComponent(path.slice('/api/memory/'.length))
      const store = runtime.get().memoryStore
      const ok = await store.remove(id)
      json(res, ok ? 200 : 404, { ok })
      return
    }
    if (req.method === 'POST' && path === '/api/memory/clear') {
      const body = (await readJsonBody(req)) as { scope?: string }
      const store = runtime.get().memoryStore
      const scope = (body.scope as MemoryScope) ?? undefined
      const n = await store.clear(scope)
      json(res, 200, { cleared: n })
      return
    }
    // ===== 自生长知识库 =====
    // 列出知识文档（scope=global/workspace，q 关键字过滤）
    if (req.method === 'GET' && path === '/api/knowledge') {
      const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
      if (!kb) {
        json(res, 200, { enabled: false, hasEmbedding: false, docs: [] })
        return
      }
      const q = url.searchParams.get('q') ?? undefined
      const spaceId = url.searchParams.get('spaceId') ?? undefined
      const folderId = url.searchParams.get('folderId') ?? undefined
      const docs = await kb.store.list({ q, spaceId, folderId })
      json(res, 200, { enabled: true, hasEmbedding: kb.service.hasEmbedding, docs })
      return
    }
    // 上传文档入库：支持 files（文件名+base64，自动抽取文本）或直接 text
    if (req.method === 'POST' && path === '/api/knowledge/upload') {
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用（请在设置中开启后重试）' })
        return
      }
      const body = (await readJsonBody(req)) as {
        scope?: 'global' | 'workspace'
        tags?: string[]
        title?: string
        text?: string
        spaceId?: string
        folderId?: string | null
        files?: Array<{ name?: string; dataBase64?: string }>
      }
      const targetScope = body.scope ?? 'global'
      const store = resolveKbStore(runtime, targetScope)?.store ?? kb.store
      const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : undefined
      const spaceId = typeof body.spaceId === 'string' ? body.spaceId : undefined
      const folderId = typeof body.folderId === 'string' ? body.folderId : null
      const added: Array<{ title: string; source: string; chunkCount: number }> = []
      // 直接文本入库
      if (typeof body.text === 'string' && body.text.trim()) {
        const doc = await store.addDocument({
          title: body.title?.trim() || '未命名文档',
          source: '手动输入',
          scope: targetScope,
          text: body.text,
          tags,
          spaceId,
          folderId,
        })
        added.push({ title: doc.title, source: doc.source, chunkCount: doc.chunkCount })
      }
      // 文件批量入库
      for (const file of body.files ?? []) {
        if (!file?.dataBase64) continue
        const name = file.name || 'unknown'
        const buffer = Buffer.from(file.dataBase64, 'base64')
        const text = extractText(name, buffer)
        if (!text.trim()) {
          json(res, 400, { error: `「${name}」未能抽取到文本内容（支持 txt/md/csv/json/yaml/code 及 docx/pptx/xlsx）` })
          return
        }
        const doc = await store.addDocument({
          title: body.title?.trim() || name.replace(/\.[^.]+$/, ''),
          source: name,
          scope: targetScope,
          text,
          tags,
          spaceId,
          folderId,
        })
        added.push({ title: doc.title, source: doc.source, chunkCount: doc.chunkCount })
      }
      if (!added.length) {
        json(res, 400, { error: '未提供可入库的内容（text 或 files）' })
        return
      }
      json(res, 200, { ok: true, added })
      return
    }
    // ===== 多知识空间（ima / 飞书式知识库）=====
    // 列出知识空间（scope=global/workspace，缺省 global）
    if (req.method === 'GET' && path === '/api/knowledge/spaces') {
      const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
      if (!kb) {
        json(res, 200, { spaces: [], defaultSpaceId: undefined })
        return
      }
      const spaces = await kb.store.spaces()
      json(res, 200, { spaces, defaultSpaceId: spaces.find((s) => s.builtin)?.id })
      return
    }
    // 创建知识空间
    if (req.method === 'POST' && path === '/api/knowledge/spaces') {
      const body = (await readJsonBody(req)) as { name?: string; description?: string; scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      if (!body.name?.trim()) {
        json(res, 400, { error: '请输入空间名称' })
        return
      }
      const space = await kb.store.createSpace(body.name, body.description)
      json(res, 200, { space })
      return
    }
    // 空间下目录列表（可含嵌套层级）
    if (req.method === 'GET' && path.startsWith('/api/knowledge/spaces/') && path.endsWith('/folders')) {
      const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)\/folders$/)
      const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const spaceId = decodeURIComponent(m[1])
      const folders = await kb.store.folders(spaceId)
      json(res, 200, { folders })
      return
    }
    // 在空间下创建目录
    if (req.method === 'POST' && path.startsWith('/api/knowledge/spaces/') && path.endsWith('/folders')) {
      const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)\/folders$/)
      const body = (await readJsonBody(req)) as { name?: string; parentId?: string | null; scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const spaceId = decodeURIComponent(m[1])
      if (!body.name?.trim()) {
        json(res, 400, { error: '请输入目录名称' })
        return
      }
      const folder = await kb.store.createFolder(spaceId, body.name, body.parentId)
      json(res, 200, { folder })
      return
    }
    // 更新空间（重命名 / 描述）
    if (req.method === 'PATCH' && path.startsWith('/api/knowledge/spaces/')) {
      const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)$/)
      const body = (await readJsonBody(req)) as { name?: string; description?: string; scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const space = await kb.store.updateSpace(decodeURIComponent(m[1]), body)
      json(res, space ? 200 : 404, space ? { space } : { error: '空间不存在' })
      return
    }
    // 删除空间（级联删除其文档与目录）
    if (req.method === 'DELETE' && path.startsWith('/api/knowledge/spaces/')) {
      const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)$/)
      const body = (await readJsonBody(req).catch(() => ({}))) as { scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      try {
        const r = await kb.store.deleteSpace(decodeURIComponent(m[1]))
        json(res, 200, { ok: true, docs: r.docs })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    // 更新目录（重命名 / 移动）
    if (req.method === 'PATCH' && path.startsWith('/api/knowledge/folders/')) {
      const m = path.match(/^\/api\/knowledge\/folders\/([^/]+)$/)
      const body = (await readJsonBody(req)) as { name?: string; parentId?: string | null; scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      try {
        const folder = await kb.store.updateFolder(decodeURIComponent(m[1]), body)
        json(res, folder ? 200 : 404, folder ? { folder } : { error: '目录不存在' })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    // 删除目录（文档移到根目录，子目录上移）
    if (req.method === 'DELETE' && path.startsWith('/api/knowledge/folders/')) {
      const m = path.match(/^\/api\/knowledge\/folders\/([^/]+)$/)
      const body = (await readJsonBody(req).catch(() => ({}))) as { scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const r = await kb.store.deleteFolder(decodeURIComponent(m[1]))
      json(res, 200, { ok: true, docs: r.docs })
      return
    }
    // 移动文档到指定空间 / 目录
    if (req.method === 'PATCH' && path.startsWith('/api/knowledge/') && path.endsWith('/move')) {
      const m = path.match(/^\/api\/knowledge\/([^/]+)\/move$/)
      const body = (await readJsonBody(req)) as { spaceId?: string; folderId?: string | null; scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, body.scope ?? undefined)
      if (!m || !kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      if (!body.spaceId) {
        json(res, 400, { error: '缺少目标空间' })
        return
      }
      try {
        const ok = await kb.store.moveDoc(decodeURIComponent(m[1]), body.spaceId, body.folderId ?? null)
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '文档不存在' })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    // ===== 知识库问答（带溯源）=====
    if (req.method === 'POST' && path === '/api/knowledge/ask') {
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用（请在设置中开启后重试）' })
        return
      }
      const body = (await readJsonBody(req)) as { q?: string; scope?: 'global' | 'workspace'; spaceId?: string; topK?: number }
      const q = (body.q ?? '').trim()
      if (!q) {
        json(res, 400, { error: '请输入要提问的内容' })
        return
      }
      const cfg = loadWebConfig()
      if (!cfg.apiKey || !cfg.model) {
        json(res, 400, { error: '未配置模型，无法进行知识库问答' })
        return
      }
      const scope = body.scope === 'workspace' ? 'workspace' : 'global'
      const base = scope === 'workspace' ? kb.service.workspace ?? kb.service.global : kb.service.global
      const retriever = base.retriever
      const topK = Math.max(1, Math.min(10, body.topK ?? 5))
      const hits = await retriever.search({
        q,
        scope,
        workspace: scope === 'workspace' ? runtime.workspacePath ?? undefined : undefined,
        topK,
      })
      if (!hits.length) {
        json(res, 200, { answer: '知识库中暂未找到与问题相关的内容。', hits: [] })
        return
      }
      const provider = new OpenAICompatibleProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
        model: cfg.model,
      })
      const ctx = hits.map((h, i) => `[${i + 1}] 来源《${h.docTitle}》：${h.text.trim()}`).join('\n\n')
      const prompt = [
        '你是一个严谨的知识库问答助手。请仅基于下面给定的知识库检索片段回答用户问题。',
        '若引用到片段，请在句末以 [1][2] 形式标注对应来源编号。',
        '若片段不足以回答，请明确说明「知识库中未找到足够依据」。',
        '',
        '知识库片段：',
        ctx,
        '',
        '用户问题：' + q,
      ].join('\n')
      const result = await provider.chat([
        { role: 'system', content: '你只依据给定知识库片段作答，输出简洁、专业、可溯源的中文回答。' },
        { role: 'user', content: prompt },
      ])
      const answer = (result.content ?? '').trim()
      json(res, 200, { answer, hits })
      return
    }
    // 删除单个文档
    if (req.method === 'DELETE' && path.startsWith('/api/knowledge/')) {
      const id = decodeURIComponent(path.slice('/api/knowledge/'.length))
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const ok = (await kb.store.remove(id)) || (await (kb.service.workspace?.store ?? kb.store).remove(id))
      json(res, ok ? 200 : 404, { ok })
      return
    }
    // 清空（scope 缺省清全部）
    if (req.method === 'POST' && path === '/api/knowledge/clear') {
      const body = (await readJsonBody(req)) as { scope?: 'global' | 'workspace' }
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      let cleared = 0
      if (body.scope === 'workspace' && kb.service.workspace) {
        cleared = await kb.service.workspace.store.clear('workspace')
      } else if (body.scope === 'global') {
        cleared = await kb.store.clear('global')
      } else {
        cleared = await kb.store.clear()
        if (kb.service.workspace) cleared += await kb.service.workspace.store.clear()
      }
      json(res, 200, { cleared })
      return
    }
    // 为缺失向量的分块补做向量化（配置了 embedding 后重新索引）
    if (req.method === 'POST' && path === '/api/knowledge/reindex') {
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const global = await kb.store.reindex()
      const workspace = kb.service.workspace ? await kb.service.workspace.store.reindex() : { total: 0, embedded: 0 }
      json(res, 200, { global, workspace, hasEmbedding: kb.service.hasEmbedding })
      return
    }
    // 查看单个词条内容（跨 global/workspace 查找，分块按序拼接）
    if (req.method === 'GET' && path.startsWith('/api/knowledge/')) {
      const id = decodeURIComponent(path.slice('/api/knowledge/'.length))
      const kb = resolveKbStore(runtime, undefined)
      if (!kb) {
        json(res, 400, { error: '知识库未启用' })
        return
      }
      const globalStore = kb.service.global.store
      const workspaceStore = kb.service.workspace?.store
      let doc = await globalStore.get(id)
      let store = globalStore
      if (!doc && workspaceStore) {
        doc = await workspaceStore.get(id)
        store = workspaceStore
      }
      if (!doc) {
        json(res, 404, { error: '未找到该词条' })
        return
      }
      const content = (await store.chunks())
        .filter((c) => c.docId === id)
        .sort((a, b) => a.index - b.index)
        .map((c) => c.text)
        .join('\n\n')
      json(res, 200, { doc, content })
      return
    }
    // ===== 技能管理 =====
    if (req.method === 'GET' && path === '/api/skills') {
      const store = runtime.get().skillStore
      const q = url.searchParams.get('q') ?? undefined
      const category = url.searchParams.get('category') ?? undefined
      const tag = url.searchParams.get('tag')
      const tags = tag ? tag.split(',').map((t) => t.trim()).filter(Boolean) : undefined
      const skills = await store.list({ q, category, tags })
      json(res, 200, { skills })
      return
    }
    if (req.method === 'POST' && path === '/api/skills') {
      const body = (await readJsonBody(req)) as Partial<SkillDefinition>
      if (!body.name || !body.template) {
        json(res, 400, { error: '缺少 name 或 template' })
        return
      }
      const store = runtime.get().skillStore
      const skill = await store.add({
        name: body.name,
        version: body.version,
        description: body.description ?? '',
        icon: body.icon,
        category: body.category,
        tags: body.tags,
        visibility: body.visibility,
        inputs: body.inputs ?? { type: 'object', properties: {}, required: [] },
        tools: body.tools,
        memory: body.memory,
        template: body.template,
      })
      json(res, 200, { skill })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/skills/') && path !== '/api/skills') {
      const name = decodeURIComponent(path.slice('/api/skills/'.length))
      const store = runtime.get().skillStore
      const skill = await store.get(name)
      json(res, skill ? 200 : 404, skill ? { skill } : { error: '未找到' })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/skills/') && !path.endsWith('/run')) {
      const name = decodeURIComponent(path.slice('/api/skills/'.length))
      const store = runtime.get().skillStore
      const ok = await store.remove(name)
      json(res, ok ? 200 : 404, { ok })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/skills/') && path.endsWith('/run')) {
      const name = decodeURIComponent(path.slice('/api/skills/'.length, -'/run'.length))
      const body = (await readJsonBody(req)) as { args?: Record<string, unknown> }
      const store = runtime.get().skillStore
      const skill = await store.get(name)
      if (!skill) {
        json(res, 404, { error: '未找到技能' })
        return
      }
      try {
        const { buildSkillPrompt } = await import('@zhuxing/harness-skills')
        const prompt = buildSkillPrompt(skill, body.args ?? {})
        json(res, 200, { prompt, tools: skill.tools })
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/skills/upload') {
      const body = (await readJsonBody(req)) as {
        files?: Array<{ name?: string; dataBase64?: string }>
        review?: boolean
      }
      const files = body.files ?? []
      if (!files.length) {
        json(res, 400, { error: '未上传文件' })
        return
      }
      const cfg = loadWebConfig()
      let candidates = await buildSkillCandidates(files)
      if (body.review !== false) {
        candidates = await Promise.all(candidates.map((c) => reviewSkillCandidate(c, cfg)))
      }
      json(res, 200, { candidates })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/install') {
      const body = (await readJsonBody(req)) as { skill?: SkillDefinition; scope?: string }
      const skill = body.skill
      if (!skill?.name || !skill?.template) {
        json(res, 400, { error: '缺少 name 或 template' })
        return
      }
      const normalized = normalizeSkillDefinition(skill)
      const issues = validateSkillDefinition(normalized)
      if (issues.length) {
        json(res, 400, { error: `技能存在校验问题：${issues.join('；')}` })
        return
      }
      const store = runtime.get().skillStore
      const dir = resolveSkillTargetDir(runtime, body.scope ?? 'global')
      if (!dir) {
        json(res, 400, { error: '安装目录无效' })
        return
      }
      const added = await store.add(normalized, dir)
      json(res, 200, { skill: added, dir })
      return
    }
    // ===== 专业化能力包 =====
    // 列出已验证的专业化包（含内置知识文档数量与启用状态）
    if (req.method === 'GET' && path === '/api/specs') {
      const specs = await runtime.get().specManager.list()
      json(res, 200, { specs })
      return
    }
    // 安装 zip 能力包（manifest.json + skills/*.yaml + knowledge/*），默认启用
    if (req.method === 'POST' && path === '/api/specs/install') {
      const body = (await readJsonBody(req)) as { data?: string }
      if (!body.data) {
        json(res, 400, { error: '缺少专业化包数据（base64 zip）' })
        return
      }
      let buf: Buffer
      try {
        buf = Buffer.from(body.data, 'base64')
      } catch {
        json(res, 400, { error: '数据不是有效的 base64' })
        return
      }
      const specManager = runtime.get().specManager
      let result: Awaited<ReturnType<SpecManager['install']>>
      try {
        result = await specManager.install(buf)
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        return
      }
      // 安装后重建运行时：技能目录与知识库同步已启用包的资源
      await runtime.reload()
      json(res, 200, { ok: true, spec: result.spec })
      return
    }
    // 启用 / 禁用 / 移除（路径须含 :id）
    if (req.method === 'POST' && path.startsWith('/api/specs/') && (path.endsWith('/enable') || path.endsWith('/disable'))) {
      const id = decodeURIComponent(path.slice('/api/specs/'.length, path.endsWith('/enable') ? -'/enable'.length : -'/disable'.length))
      const enable = path.endsWith('/enable')
      const specManager = runtime.get().specManager
      const ok = enable ? await specManager.enable(id) : await specManager.disable(id)
      if (!ok) {
        json(res, 404, { error: '未找到专业化包' })
        return
      }
      await runtime.reload()
      json(res, 200, { ok: true, enabled: enable })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/specs/')) {
      const id = decodeURIComponent(path.slice('/api/specs/'.length))
      const specManager = runtime.get().specManager
      const ok = await specManager.remove(id)
      if (!ok) {
        json(res, 404, { error: '未找到专业化包' })
        return
      }
      await runtime.reload()
      json(res, 200, { ok: true })
      return
    }
    // ===== 工具管理（复用常驻运行时，不再每请求创建 Harness）=====
    if (req.method === 'GET' && path === '/api/tools') {
      const r = runtime.get()
      const list = r.tools.list().map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
      json(res, 200, { tools: list })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/tools/') && path.endsWith('/test')) {
      const name = decodeURIComponent(path.slice('/api/tools/'.length, -'/test'.length))
      const body = (await readJsonBody(req)) as { args?: Record<string, unknown> }
      const r = runtime.get()
      const result = await r.tools.execute(name, body.args ?? {}, {
        emit: (event, payload) => r.app.events.emit(event, payload),
      })
      json(res, 200, { result })
      return
    }
    // 静态资源（内存缓存）
    await serveStatic(res, staticAssets, path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) json(res, 500, { error: maskSecrets(msg) })
    else res.end()
  }
}

async function handleChat(
  res: ServerResponse,
  message: string,
  sessionId: string | undefined,
  runtime: RuntimeManager,
  attachments?: Array<{ type: 'image'; dataUrl: string }>,
  spaceId?: string,
  contextSessionId?: string,
): Promise<void> {
  if (!message.trim() && !attachments?.length) {
    json(res, 400, { error: '消息不能为空' })
    return
  }

  // SSE 响应
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const r = runtime.get()
  const app = r.app
  let clientClosed = false
  const send = (event: string, data: unknown) => {
    if (!clientClosed) sse(res, event, data)
  }

  // 请求级订阅：结束时精确解绑，不泄漏到常驻运行时
  const unsubs: Array<() => void> = []
  unsubs.push(
    app.events.on('agent/pre-step', (p: { step: number }) => send('step', { step: (p.step as number) + 1 }), 'web'),
    app.events.on('tools/before-exec', (p: { name: string; args: Record<string, unknown> }) => send('tool', { name: p.name, args: p.args }), 'web'),
    app.events.on('tools/after-exec', (p: { name: string; result: unknown }) => send('tool_result', { name: p.name, result: p.result }), 'web'),
  )

  res.once('close', () => {
    clientClosed = true
  })
  try {
    const activeSessionId = await runtime.resolveSessionId(sessionId)
    const result = await r.agent.run(message, activeSessionId, {
      onToken: (t) => send('token', { text: t }),
      attachments,
      contextSessionId,
    })
    if (result.finishedReason === 'error') {
      send('error', {
        message: result.lastRaw ? maskSecrets(String(result.lastRaw)) : '模型调用失败，请检查 API Key / 网络 / 模型配置。',
      })
    }
    // 首次消息将新会话归属到指定空间（不覆盖已有归属）。
    if (spaceId && result.sessionId) {
      const store = runtime.get().sessionStore
      const meta = await store.getMeta(result.sessionId)
      if (!meta) {
        const now = Date.now()
        await store.setMeta({ id: result.sessionId, spaceId, createdAt: now, updatedAt: now })
      } else if (!meta.spaceId) {
        await store.setMeta({ ...meta, spaceId, updatedAt: Date.now() })
      }
    }
    send('result', {
      content: result.content,
      steps: result.steps,
      finishedReason: result.finishedReason,
      sessionId: result.sessionId,
    })
  } catch (err) {
    send('error', { message: maskSecrets(err instanceof Error ? err.message : String(err)) })
  } finally {
    for (const off of unsubs) off()
    sseEnd(res)
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      // 容纳 50MB 文件的 base64（约 66.7MB），预留 JSON 包裹与余量
      if (data.length > 80 * 1024 * 1024) rejectBody(new Error('请求体过大'))
    })
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {})
      } catch {
        rejectBody(new Error('JSON 解析失败'))
      }
    })
    req.on('error', rejectBody)
  })
}

// ============ 技能上传 / 审核 / 安装 ============

/** 上传文件中解析出的技能候选。 */
interface SkillCandidate {
  sourceFile: string
  skill: SkillDefinition | null
  issues: string[]
  review: {
    status: 'approve' | 'reject' | 'needs_fix' | 'skipped'
    feedback: string
  }
}

function isYamlFile(name: string): boolean {
  return /\.(ya?ml)$/i.test(name)
}

function fileToText(buffer: Buffer): string {
  try {
    return buffer.toString('utf-8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

/** 从单个文件字节中解析出技能定义（相对宽松：仅要求可解析为对象）。 */
function parseSkillFromText(content: string): { skill?: SkillDefinition; error?: string } {
  const { skill, error } = parseSkill(content)
  return { skill, error }
}

/** 从 .zip 字节中提取所有技能的 YAML 内容（批量导入）。 */
function extractYamlFromZip(buffer: Buffer): Array<{ name: string; content: string }> {
  const zip = new AdmZip(buffer)
  const outputs: Array<{ name: string; content: string }> = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (!isYamlFile(entry.entryName)) continue
    const content = fileToText(entry.getData())
    outputs.push({ name: entry.entryName, content })
  }
  return outputs
}

/** 将一组上传文件（单选 yaml 或 zip 批量）解析为技能候选列表。 */
function buildSkillCandidates(
  files: Array<{ name?: string; dataBase64?: string }>,
): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = []
  for (const file of files) {
    if (!file?.dataBase64) continue
    const rawName = file.name || 'skill.yaml'
    const buffer = Buffer.from(file.dataBase64, 'base64')
    const yamlTexts: Array<{ name: string; content: string }> = []
    if (isYamlFile(rawName)) {
      yamlTexts.push({ name: rawName, content: fileToText(buffer) })
    } else if (/\.(zip)$/i.test(rawName)) {
      try {
        yamlTexts.push(...extractYamlFromZip(buffer))
      } catch (err) {
        candidates.push({
          sourceFile: rawName,
          skill: null,
          issues: [`解压 zip 失败：${err instanceof Error ? err.message : String(err)}`],
          review: { status: 'reject', feedback: '压缩包无法解压' },
        })
        continue
      }
    } else {
      candidates.push({
        sourceFile: rawName,
        skill: null,
        issues: ['仅支持 .yaml/.yml 或 .zip 文件'],
        review: { status: 'reject', feedback: '不支持的格式' },
      })
      continue
    }
    if (yamlTexts.length === 0) {
      candidates.push({
        sourceFile: rawName,
        skill: null,
        issues: ['未在压缩包中找到 .yaml/.yml 技能定义文件'],
        review: { status: 'reject', feedback: '压缩包内没有技能 YAML' },
      })
      continue
    }
    for (const y of yamlTexts) {
      const { skill, error } = parseSkillFromText(y.content)
      if (!skill) {
        candidates.push({
          sourceFile: y.name,
          skill: null,
          issues: [error ?? '解析失败'],
          review: { status: 'reject', feedback: '无法解析为技能定义' },
        })
        continue
      }
      candidates.push({
        sourceFile: y.name,
        skill: normalizeSkillDefinition(skill),
        issues: validateSkillDefinition(skill),
        review: { status: 'skipped', feedback: '' },
      })
    }
  }
  return Promise.resolve(candidates)
}

/** 调用 AI 对单个技能候选做审核/规整，返回审核结论并更新候选。 */
async function reviewSkillCandidate(candidate: SkillCandidate, cfg: WebConfig): Promise<SkillCandidate> {
  const apiKey = cfg.apiKey
  const model = cfg.model
  if (!apiKey || !model) {
    return { ...candidate, review: { status: 'skipped', feedback: '未配置模型，已跳过 AI 审核' } }
  }
  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
    model,
  })
  const prompt = [
    '你是一个技能（Skill）审核员。技能是一段可复用的提示词模板，需符合以下结构：',
    '字段：name(必填,字母数字与 _-)、version、description(必填)、icon、category、tags、visibility(public/private)、inputs(JSON Schema)、tools(字符串数组)、memory、template(必填,含 {{param}} 占位符)。',
    '请检查候选技能定义，找出：1) 字段缺失/类型错误；2) name 非法；3) template 占位符与 inputs.properties 不匹配；4) 描述/提示词质量问题。',
    '若可修复则修复并返回 status=approve，并给出修复后的完整 JSON；无法修复返回 reject；小问题返回 needs_fix。',
    '严格按如下 JSON 输出（不要用代码块包裹，不要附加解释）：',
    '{"status":"approve"|"reject"|"needs_fix","feedback":"简短中文说明","issues":["..."],"skill":{完整技能定义JSON}}',
    '',
    '待审核技能定义：',
    JSON.stringify(candidate.skill, null, 2),
  ].join('\n')

  try {
    const result = await provider.chat([
      { role: 'system', content: '你是严谨的技能审核员，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    const text = (result.content ?? '').trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(text) as { status?: string; feedback?: string; issues?: string[]; skill?: SkillDefinition }
    const status = parsed.status === 'approve' ? 'approve' : parsed.status === 'reject' ? 'reject' : parsed.status === 'needs_fix' ? 'needs_fix' : 'skipped'
    let skill = candidate.skill
    if (parsed.skill && typeof parsed.skill === 'object') {
      skill = normalizeSkillDefinition(parsed.skill)
    }
    return {
      sourceFile: candidate.sourceFile,
      skill,
      issues: validateSkillDefinition(skill ?? {}),
      review: { status, feedback: parsed.feedback ?? '' },
    }
  } catch (err) {
    return {
      ...candidate,
      review: { status: 'skipped', feedback: `AI 审核失败，已跳过：${err instanceof Error ? err.message : String(err)}` },
    }
  }
}

/** 根据安装范围解析实际目录。 */
function resolveSkillTargetDir(runtime: RuntimeManager, scope: string): string | undefined {
  if (scope === 'global') return defaultSkillDirs(runtime.workspacePath)[0]
  if (scope === 'project') return defaultSkillDirs(runtime.workspacePath)[1]
  if (scope && typeof scope === 'string') return scope
  return undefined
}

/** 解析知识库存储：默认全局；scope=workspace 时取工作区（无则回退全局）；未启用返回 undefined。 */
function resolveKbStore(
  runtime: RuntimeManager,
  scope?: string,
): { service: KnowledgeService; store: KnowledgeService['global']['store'] } | undefined {
  const service = runtime.get().knowledgeService
  if (!service) return undefined
  const base = scope === 'workspace' ? service.workspace ?? service.global : service.global
  return { service, store: base.store }
}

/** 启动时把 UI 静态资源读入内存（带 MIME 与内容哈希 ETag）。 */
function loadStaticAssets(uiDir: string): Map<string, { type: string; data: Buffer; etag: string }> {
  const assets = new Map<string, { type: string; data: Buffer; etag: string }>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) {
        const data = readFileSync(full)
        assets.set(rel, {
          type: MIME[extname(full)] ?? 'application/octet-stream',
          data,
          etag: `"${createHash('sha1').update(data).digest('hex')}"`,
        })
      }
    }
  }
  if (existsSync(uiDir)) walk(uiDir, '')
  return assets
}

async function serveStatic(
  res: ServerResponse,
  assets: Map<string, { type: string; data: Buffer; etag: string }>,
  path: string,
): Promise<void> {
  const safePath = path === '/' ? 'index.html' : path.slice(1).replace(/^[/\\]+/, '')
  const asset = assets.get(safePath) ?? assets.get('index.html')
  if (!asset) {
    json(res, 404, { error: '未找到资源' })
    return
  }
  if (reqIfNoneMatch(res, asset.etag)) {
    res.writeHead(304, { ETag: asset.etag })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Cache-Control': safePath.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    ETag: asset.etag,
  })
  res.end(asset.data)
}

/** 简单 If-None-Match 校验。 */
function reqIfNoneMatch(res: ServerResponse, etag: string): boolean {
  const header = res.req.headers['if-none-match']
  return typeof header === 'string' && header === etag
}
