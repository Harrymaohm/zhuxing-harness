import http from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { maskSecrets } from '@zhuxing/harness-kernel'
import { loadWebConfig, maskWebConfig, parseWebModels, saveWebConfig, webConfigPath, webSessionDir } from './config-store.js'
import { json } from './http.js'
import type { StaticAssets } from './http.js'
import { defaultUiDir, isPublicPath, loadStaticAssets, serveStatic } from './static-assets.js'
import { RuntimeManager } from './runtime.js'
import { handleCoreRoutes } from './routes/core.js'
import { handleConfigRoutes } from './routes/config.js'
import { handleWorkspaceRoutes } from './routes/workspace.js'
import { handleModelListRoute, handleTokenPlanModelsRoute } from './routes/models.js'
import { handleSessionRoutes } from './routes/sessions.js'
import { handleChatRoutes } from './routes/chat.js'
import { handleUpdateRoutes } from './routes/update.js'
import { handleTerminalRoutes } from './routes/terminal-exec.js'
import { handleFileRoutes } from './routes/files.js'
import { handleMemoryRoutes } from './routes/memory.js'
import { handleKnowledgeRoutes } from './routes/knowledge.js'
import { handleSkillRoutes } from './routes/skills.js'
import { handleSpecRoutes } from './routes/specs.js'
import { handleToolRoutes } from './routes/tools.js'
import type { RouteContext } from './routes/context.js'

// 对外导出面不变（包入口即本文件）：配置读写 / 掩码 / 路径解析
export { loadWebConfig, maskWebConfig, parseWebModels, saveWebConfig, webConfigPath, webSessionDir }
export type { WebConfig, TokenPlanConfig, ImageModelConfig } from './config-store.js'

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

/**
 * 请求总入口：认证中间件 + 错误边界 + 按域依次分发的路由表。
 *
 * 各 `handleXxxRoutes` 返回「是否已处理」；分发顺序与原单函数内的判定链逐条对齐，
 * 以免 startsWith / endsWith 型分支提前命中而抢占路由（/api/models 在原链中位于
 * 会话与空间之后，故此处单独一次调用，而非并入 token-plan 那一处）。
 */
async function handleRequest(
  req: http.IncomingMessage,
  res: ServerResponse,
  runtime: RuntimeManager,
  staticAssets: StaticAssets,
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

  const ctx: RouteContext = { runtime, staticAssets, accessToken, url, path }

  try {
    if (await handleCoreRoutes(req, res, ctx)) return
    if (await handleConfigRoutes(req, res, ctx)) return
    if (await handleWorkspaceRoutes(req, res, ctx)) return
    if (await handleTokenPlanModelsRoute(req, res, ctx)) return
    if (await handleSessionRoutes(req, res, ctx)) return
    if (await handleModelListRoute(req, res, ctx)) return
    if (await handleChatRoutes(req, res, ctx)) return
    if (await handleUpdateRoutes(req, res, ctx)) return
    if (await handleTerminalRoutes(req, res, ctx)) return
    if (await handleFileRoutes(req, res, ctx)) return
    if (await handleMemoryRoutes(req, res, ctx)) return
    if (await handleKnowledgeRoutes(req, res, ctx)) return
    if (await handleSkillRoutes(req, res, ctx)) return
    if (await handleSpecRoutes(req, res, ctx)) return
    if (await handleToolRoutes(req, res, ctx)) return
    // 静态资源（内存缓存）
    await serveStatic(res, staticAssets, path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) json(res, 500, { error: maskSecrets(msg) })
    else res.end()
  }
}
