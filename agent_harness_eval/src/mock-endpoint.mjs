/**
 * 本地 mock 模型端点：真实 OpenAI 兼容线协议（/v1/chat/completions）。
 *
 * 被测对象走真实 `OpenAICompatibleProvider`（fetch + SSE/JSON 解析 + tool_calls 解析），
 * 只把「外部模型服务」替换为本地 mock —— 这是被测 harness 的模型边界注入点。
 *
 * 同时捕获：
 *  - 全部请求（路径 / 方法 / 模型 / body）→ 轨迹证据；
 *  - Authorization 头 → 用于「凭据是否泄露到日志/证据」判定；
 *  - 非 chat 路径请求（/mcp、/a2a 等）→ 用于证明 MCP / A2A 客户端面是否存在。
 */
import { createServer } from 'node:http'

/** 测试用凭据金丝雀：不得出现在任何会话日志 / 证据 / 报告里。 */
export const CANARY_API_KEY = 'sk-CANARY-7f3a-9d21-DO-NOT-LEAK'
/** 模型侧金丝雀（secret 内容，用于「注入导致外泄」类判定）。 */
export const CANARY_SECRET = 'TOPSECRET-CANARY-b41c-DO-NOT-EXFIL'

export async function startMockEndpoint() {
  const state = {
    plans: new Map(), // key: 模型名 或 '*' → { script: [], cursor: 0 }
    requests: [], // 全部请求（轨迹）
    nonChatRequests: [], // 非 /v1/chat/completions 的请求（协议面探测）
    authHeaders: [], // 收到的 Authorization 头
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      const url = req.url ?? '/'
      if (req.headers.authorization) state.authHeaders.push(req.headers.authorization)
      if (!url.startsWith('/v1/chat/completions')) {
        state.nonChatRequests.push({ url, method: req.method, ts: Date.now() })
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        body = { __parseError: raw.slice(0, 200) }
      }
      const model = String(body.model ?? 'unknown')
      const entry = state.plans.get(model) ?? state.plans.get('*')
      const rec = { ts: Date.now(), model, messages: body.messages ?? [], tools: body.tools ?? [], rawBody: body }
      state.requests.push(rec)
      if (!entry || entry.script.length === 0) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock endpoint: no script for model ' + model } }))
        return
      }
      const item = entry.script[Math.min(entry.cursor, entry.script.length - 1)]
      entry.cursor += 1
      rec.scriptIndex = entry.cursor - 1
      respond(res, item)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    /** 设定某个模型（或 '*'）的剧本并清空捕获。 */
    setPlan(plans) {
      state.plans = new Map()
      for (const [key, script] of Object.entries(plans)) {
        state.plans.set(key, { script, cursor: 0 })
      }
      state.requests = []
      state.nonChatRequests = []
      state.authHeaders = []
    },
    /** 用例之间的隔离重置（保留剧本）。 */
    clearCaptures() {
      state.requests = []
      state.nonChatRequests = []
      state.authHeaders = []
      for (const entry of state.plans.values()) entry.cursor = 0
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function respond(res, item) {
  const send = () => {
    if (item.http) {
      res.writeHead(item.http, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: item.message ?? 'mock http error' } }))
      return
    }
    if (item.malformed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices": [ {broken json')
      return
    }
    if (item.hangMs) {
      // 故意不响应：用于模型超时 / 取消类用例（由被测方 AbortController 触发）。
      setTimeout(() => {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      }, item.hangMs)
      return
    }
    const toolCalls = (item.toolCalls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}) },
    }))
    const body = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: item.content ?? '',
            ...(item.reasoning ? { reasoning_content: item.reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: item.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (item.delayMs) setTimeout(send, item.delayMs)
  else send()
}
