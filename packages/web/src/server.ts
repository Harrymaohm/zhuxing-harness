import http from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, maskSecrets } from '@zhuxing/harness-kernel'
import { baseBundlePlugins } from '@zhuxing/harness-bundle'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import type { SessionService } from '@zhuxing/harness-session'
import { FileSessionStore } from '@zhuxing/harness-session'
import type { AgentResult } from '@zhuxing/harness-agent'

// ============ 配置读写（与 cli config-store 对齐，避免跨包内部 import） ============

export interface WebConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: 'read-only' | 'workspace-write' | 'danger-full-access'
  sessionDir?: string
  [key: string]: unknown
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
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const uiDir = options.uiDir ?? resolve(fileURLToPath(new URL('../dist-ui', import.meta.url)))

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, uiDir)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? 0, host, () => resolveListen())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
  return { server, port, url: `http://${host}:${port}` }
}

async function handleRequest(req: http.IncomingMessage, res: ServerResponse, uiDir: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  try {
    if (req.method === 'GET' && path === '/api/health') {
      json(res, 200, { ok: true, version: VERSION })
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      const cfg = loadWebConfig()
      json(res, 200, { ...cfg, apiKey: cfg.apiKey ? maskSecrets(cfg.apiKey) : undefined })
      return
    }
    if (req.method === 'POST' && path === '/api/config') {
      const body = (await readJsonBody(req)) as Partial<WebConfig>
      const allowed: Partial<WebConfig> = {}
      for (const key of ['apiKey', 'baseUrl', 'model', 'workspace', 'level', 'sessionDir'] as const) {
        if (body[key] !== undefined) (allowed as Record<string, unknown>)[key] = body[key]
      }
      const merged = { ...loadWebConfig(), ...allowed }
      const p = saveWebConfig(merged)
      json(res, 200, { ok: true, path: p })
      return
    }
    if (req.method === 'GET' && path === '/api/sessions') {
      const cfg = loadWebConfig()
      const store = new FileSessionStore(webSessionDir(cfg))
      const ids = await store.listSessions()
      const sessions = []
      for (const id of ids) {
        const events = await store.list(id)
        const first = events[0]
        sessions.push({
          id,
          eventCount: events.length,
          createdAt: first ? first.ts : undefined,
          preview: first?.payload ? String((first.payload as { content?: string }).content ?? '').slice(0, 80) : '',
        })
      }
      sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      json(res, 200, { sessions })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/sessions/') && path.endsWith('/events')) {
      const id = path.slice('/api/sessions/'.length, -'/events'.length)
      const cfg = loadWebConfig()
      const store = new FileSessionStore(webSessionDir(cfg))
      const events = await store.list(id)
      json(res, 200, { sessionId: id, events })
      return
    }
    if (req.method === 'POST' && path === '/api/chat') {
      const body = (await readJsonBody(req)) as { message?: string; sessionId?: string }
      await handleChat(res, body.message ?? '', body.sessionId)
      return
    }
    // 静态资源
    await serveStatic(res, uiDir, path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) json(res, 500, { error: maskSecrets(msg) })
    else res.end()
  }
}

async function handleChat(res: ServerResponse, message: string, sessionId?: string): Promise<void> {
  if (!message.trim()) {
    json(res, 400, { error: '消息不能为空' })
    return
  }
  const cfg = loadWebConfig()
  const sessionDir = webSessionDir(cfg)
  const workspace = resolve(cfg.workspace ?? process.cwd())

  // SSE 响应
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event: string, data: unknown) => sse(res, event, data)

  const app = createHarness({ logLevel: 'warn' })
  try {
    // 挂载基础 bundle（沙箱/会话/工具/模型/循环）
    for (const def of baseBundlePlugins({
      apiKey: cfg.apiKey ?? '',
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model ?? 'deepseek-v4-flash',
      workspace,
      level: (cfg.level ?? 'danger-full-access') as PermissionLevel,
    })) {
      const cfgOpt = def.name === 'harness-session' ? { storeDir: sessionDir } : undefined
      await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
    }

    // 进度事件转发到 SSE
    app.events.on(
      'agent/pre-step',
      (p: { step: number }) => send('step', { step: (p.step as number) + 1 }),
      'web',
    )
    app.events.on(
      'tools/before-exec',
      (p: { name: string; args: Record<string, unknown> }) => send('tool', { name: p.name, args: p.args }),
      'web',
    )
    app.events.on(
      'tools/after-exec',
      (p: { name: string; result: unknown }) => send('tool_result', { name: p.name, result: p.result }),
      'web',
    )

    const agentRecord = app.pluginManager.get('harness-agent')
    if (!agentRecord) {
      send('error', { message: 'Agent 循环未就绪' })
      sseEnd(res)
      return
    }
    const agentSvc = agentRecord.ctx.inject<{
      run: (input: string, sessionId?: string, opts?: { onToken?: (t: string) => void }) => Promise<AgentResult>
    }>('agent')
    const sessionService = app.pluginManager.get('harness-session')?.ctx.inject<SessionService>('sessionService')

    // 校验会话存在（sessionId 复用）；不存在则忽略
    let activeSessionId = sessionId
    if (activeSessionId && sessionService) {
      const store = new FileSessionStore(sessionDir)
      const ids = await store.listSessions()
      if (!ids.includes(activeSessionId)) activeSessionId = undefined
    }

    const result = await agentSvc.run(message, activeSessionId, {
      onToken: (t) => send('token', { text: t }),
    })
    if (result.finishedReason === 'error') {
      send('error', { message: '模型调用失败，请检查 API Key / 网络 / 模型配置。' })
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
    sseEnd(res)
    await app.dispose()
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      if (data.length > 5 * 1024 * 1024) rejectBody(new Error('请求体过大'))
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

async function serveStatic(res: ServerResponse, uiDir: string, path: string): Promise<void> {
  const safePath = path === '/' ? 'index.html' : path.slice(1)
  const filePath = normalize(join(uiDir, safePath))
  if (!filePath.startsWith(normalize(uiDir))) {
    json(res, 403, { error: '禁止访问' })
    return
  }
  let final = filePath
  if (existsSync(final) && !final.endsWith('.html') && !extname(final)) final = join(final, 'index.html')
  if (!existsSync(final)) {
    // SPA fallback
    const index = join(uiDir, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(readFileSync(index))
      return
    }
    json(res, 404, { error: '未找到资源' })
    return
  }
  const type = MIME[extname(final)] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type })
  res.end(readFileSync(final))
}
