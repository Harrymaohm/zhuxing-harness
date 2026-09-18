/**
 * E2E 专用的**流式**模型 mock（OpenAI 兼容 `/v1/chat/completions`）。
 *
 * 与 `agent_harness_eval/src/mock-endpoint.mjs` 的分工：那个 mock 只回非流式 JSON（评测层在用，
 * 不改动它）；而「发任务看流式 / 停止 / 刷新补挂」三条界面流程必须让上游按 `stream: true`
 * 逐块吐 `data: {...}`，否则界面收到的是一整段结果，根本无法观测「内容逐步出现」，
 * 「停止」也就没有任何可停的窗口。因此这里另起一份最小可用的 SSE mock。
 *
 * 三类请求按 system prompt / 用户输入分流：
 *   - 任务完成度校验器 → 非流式回 `OK`（否则会被判「未完成」并触发补做循环）
 *   - 任务指令精炼器   → 非流式回 `SKIP`（E2E 配置已关闭精炼，这里只是兜底）
 *   - 用户提到「预览」 → 回一段带反引号文件路径的短回答，供界面点开文件预览
 *   - 其余             → 逐块流式输出长回答（chunkCount 个分片）
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fixtures = require('./fixtures.json')

/** 单个分片的可断言文本（如「第0001段-7f2a」）。 */
export function chunkLabel(index) {
  return `${fixtures.streamChunkPrefix}${String(index).padStart(4, '0')}${fixtures.streamChunkSuffix}`
}

/** 长回答分片序列：分片数刻意远大于 100，保证「停止 / 刷新补挂」有足够长的窗口。 */
export function longAnswerPieces() {
  const pieces = [`${fixtures.streamBegin} `]
  for (let i = 1; i <= fixtures.streamChunkCount; i += 1) pieces.push(`${chunkLabel(i)} `)
  pieces.push(fixtures.streamEnd)
  return pieces
}

function previewPieces() {
  return [fixtures.previewReplyLead, `\`${fixtures.previewFileName}\``, fixtures.previewReplyTail]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function systemText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages
    .filter((m) => m?.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
}

function userText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages
    .filter((m) => m?.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
}

function classify(body) {
  const sys = systemText(body)
  if (sys.includes('校验器')) return { kind: 'verify', content: 'OK' }
  if (sys.includes('精炼器')) return { kind: 'refine', content: 'SKIP：E2E mock 不拆解' }
  if (/预览|preview/i.test(userText(body))) return { kind: 'preview', pieces: previewPieces() }
  return { kind: 'long', pieces: longAnswerPieces() }
}

function chunkPayload(model, piece) {
  return {
    id: 'chatcmpl-e2e-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
  }
}

function completionPayload(model, content) {
  return {
    id: 'chatcmpl-e2e-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 64, completion_tokens: content.length, total_tokens: 64 + content.length },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 启动 mock。`baseUrl` 直接写进被测配置的 `baseUrl`。
 * @param {{ chunkDelayMs?: number }} [options]
 */
export async function startStreamingMock(options = {}) {
  const chunkDelayMs = options.chunkDelayMs ?? fixtures.streamChunkDelayMs
  const state = { requests: [] }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks).toString('utf-8'))
    })
  })

  async function handle(req, res, raw) {
    const url = req.url ?? '/'
    if (!url.startsWith('/v1/chat/completions')) {
      sendJson(res, 404, { error: { message: 'not found' } })
      return
    }
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      sendJson(res, 400, { error: { message: 'invalid json body' } })
      return
    }
    const model = String(body.model ?? 'e2e-mock')
    const route = classify(body)
    state.requests.push({ ts: Date.now(), model, kind: route.kind, stream: body.stream === true })

    // 校验器 / 精炼器：始终走非流式一次性应答
    if (route.kind === 'verify' || route.kind === 'refine') {
      sendJson(res, 200, completionPayload(model, route.content))
      return
    }
    if (body.stream !== true) {
      sendJson(res, 200, completionPayload(model, route.pieces.join('')))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    res.once('close', () => {
      closed = true
    })

    for (const piece of route.pieces) {
      if (closed) return
      res.write(`data: ${JSON.stringify(chunkPayload(model, piece))}\n\n`)
      await sleep(chunkDelayMs)
    }
    if (closed) return
    res.write(`data: ${JSON.stringify({ ...chunkPayload(model, ''), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
