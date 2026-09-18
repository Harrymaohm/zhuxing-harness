import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import { readJsonBody } from '../http.js'
import { loadWebConfig } from '../config-store.js'
import { resolveWorkspace } from '../runtime.js'
import { handleTerminalExec } from '../terminal.js'
import type { RouteContext } from './context.js'

// ===== 交互式终端 =====

/** 终端执行入口：命令裁决与 SSE 输出都在 terminal.ts（与 Agent shell 同源沙箱）。 */
export async function handleTerminalRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'POST' && path === '/api/terminal/exec') {
    const body = (await readJsonBody(req)) as { command?: string }
    const cfg = loadWebConfig()
    // 执行目录与沙箱档位都取当前配置：与 Agent 用同一个 workspace、同一套策略
    handleTerminalExec(res, {
      command: String(body.command ?? ''),
      cwd: resolveWorkspace(cfg.workspace),
      level: cfg.level ?? DEFAULT_PERMISSION_LEVEL,
    })
    return true
  }
  return false
}
