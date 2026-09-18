import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from '../http.js'
import { handleChat, listActiveRuns, stopRun } from '../chat-stream.js'
import type { RouteContext } from './context.js'

/** 对话（SSE）与在跑轮次的查询 / 停止。 */
export async function handleChatRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'POST' && path === '/api/chat') {
    const body = (await readJsonBody(req)) as { message?: string; sessionId?: string; attachments?: Array<{ type: 'image'; dataUrl: string }>; spaceId?: string; contextSessionId?: string; runId?: string }
    await handleChat(res, body.message ?? '', body.sessionId, ctx.runtime, body.attachments, body.spaceId, body.contextSessionId, body.runId)
    return true
  }
  // 查询在跑的轮次：界面刷新/重开后用它恢复「停止」按钮，而不是刷新一次就再也停不下来
  if (req.method === 'GET' && path === '/api/chat/active') {
    json(res, 200, { runs: listActiveRuns() })
    return true
  }
  // 停止一轮正在跑的 Agent：客户端「停止」时调用，让服务端在下一个 step 边界退出
  if (req.method === 'POST' && path === '/api/chat/stop') {
    const body = (await readJsonBody(req)) as { runId?: string }
    const id = String(body.runId ?? '')
    if (!id) {
      json(res, 400, { error: '缺少 runId' })
      return true
    }
    json(res, 200, { stopped: stopRun(id) })
    return true
  }
  return false
}
