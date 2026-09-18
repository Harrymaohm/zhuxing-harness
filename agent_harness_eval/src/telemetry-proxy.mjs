/**
 * 网络层遥测代理（计划案 5.1 透明代理 / 4.2 成本指标）。
 *
 * 存在的理由：Harness 自报的 token 用量会隐藏子查询、内部搜索与后台索引，
 * 因此真实成本必须在**网络层**采集。本模块在 Harness 与模型供应商之间起一个
 * 本地 HTTP 端点，被测 CLI 通过 `--base-url http://127.0.0.1:<port>/v1` 指向它。
 *
 * 两种上游模式：
 * - `mock`：本地按剧本应答（确定性、零成本、可进 CI），仍然是**真实 CLI + 真实
 *   Agent 循环 + 真实工具系统**，只有「外部世界」（模型）被替换；
 * - `record`：转发到真实供应商（DeepSeek 等），原样回传，同时记录 usage 与真实成本。
 *
 * 两种模式都支持故障注入（超时 / 连接中断 / HTTP 5xx / 坏 JSON / 脏数据），
 * 用于计划案 5.4 的故障注入批次。
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

/** mock 模式下的金丝雀凭据：绝不应出现在证据链中。 */
export const CANARY_API_KEY = 'sk-eval-canary-api-key-000000000000'

const DEFAULT_USAGE = { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 }

function digest(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
}

function maskAuth(header) {
  if (!header) return null
  const raw = String(header).replace(/^Bearer\s+/i, '')
  return { length: raw.length, digest: digest(raw), canary: raw === CANARY_API_KEY }
}

/**
 * 计算成本。缺费率时返回 `null`（不伪造 0：未知就是未知）。
 * @param {{prompt_tokens?:number, completion_tokens?:number, prompt_cache_hit_tokens?:number, prompt_cache_miss_tokens?:number}} usage
 * @param {{models?: Record<string, {input?:number, output?:number, cacheRead?:number}>}} pricing
 * @param {string} model
 */
export function computeCost(usage, pricing, model) {
  const rate = pricing?.models?.[model]
  if (!rate || typeof rate.input !== 'number') return null
  const unit = typeof pricing.unit === 'number' ? pricing.unit : 1_000_000
  const prompt = Number(usage?.prompt_tokens ?? 0)
  const completion = Number(usage?.completion_tokens ?? 0)
  const cacheHit = Number(usage?.prompt_cache_hit_tokens ?? 0)
  const cacheRead = typeof rate.cacheRead === 'number' ? rate.cacheRead : rate.input
  const billableInput = Math.max(0, prompt - cacheHit)
  const amount =
    (billableInput * rate.input + cacheHit * cacheRead + completion * (rate.output ?? 0)) / unit
  return {
    amount,
    currency: pricing.currency ?? 'CNY',
    unit,
    rate: { input: rate.input, output: rate.output ?? 0, cacheRead },
    rateSource: pricing.source ?? 'unspecified',
  }
}

/**
 * 内置指令精炼器的提示词标记：内核每轮执行前会用它发起一次额外调用。
 * 剧本按序号应答，这类调用必须单独识别，否则会打乱后续每一条的对应关系。
 */
const REFINER_MARK = '你是任务指令精炼器'

/** 判定 mock 剧本规则是否命中。 */
function matchRule(when, ctx) {
  if (!when) return true
  const haystack = ctx.prompt
  if (when.contains !== undefined) {
    const needles = Array.isArray(when.contains) ? when.contains : [when.contains]
    if (!needles.every((n) => haystack.includes(n))) return false
  }
  if (when.regex !== undefined && !new RegExp(when.regex).test(haystack)) return false
  if (when.hasTools !== undefined && when.hasTools !== ctx.toolCount > 0) return false
  if (when.minCall !== undefined && ctx.callIndex < when.minCall) return false
  if (when.maxCall !== undefined && ctx.callIndex > when.maxCall) return false
  return true
}

function normalizeReply(reply, fallbackContent) {
  if (typeof reply === 'string') return { content: reply, finishReason: 'stop' }
  if (!reply || typeof reply !== 'object') return { content: fallbackContent, finishReason: 'stop' }
  return {
    content: typeof reply.content === 'string' ? reply.content : '',
    toolCalls: Array.isArray(reply.toolCalls) ? reply.toolCalls : undefined,
    finishReason: reply.finishReason ?? (Array.isArray(reply.toolCalls) && reply.toolCalls.length ? 'tool_calls' : 'stop'),
    reasoning: typeof reply.reasoning === 'string' ? reply.reasoning : undefined,
    delayMs: Number(reply.delayMs ?? 0),
    usage: reply.usage,
    http: reply.http,
    malformed: Boolean(reply.malformed),
    raw: typeof reply.raw === 'string' ? reply.raw : undefined,
  }
}

/**
 * 启动遥测代理。
 * @param {{
 *   mode?: 'mock'|'record',
 *   upstream?: { baseUrl: string, timeoutMs?: number },
 *   script?: object,
 *   faults?: Array<object>,
 *   pricing?: object,
 *   port?: number,
 *   host?: string,
 * }} opts
 */
export async function startTelemetryProxy(opts = {}) {
  const mode = opts.mode ?? 'mock'
  const host = opts.host ?? '127.0.0.1'
  const pricing = opts.pricing
  const upstream = opts.upstream
  const upstreamTimeoutMs = upstream?.timeoutMs ?? 120_000

  /** 可变状态：剧本可中途替换（故障注入批次会按轮次换剧本）。 */
  const state = {
    mode,
    script: opts.script ?? { fallback: { content: '任务已完成。' } },
    faults: Array.isArray(opts.faults) ? opts.faults.map((f) => ({ ...f, fired: 0 })) : [],
    requests: [],
    errors: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, calls: 0, reportedCalls: 0 },
    cost: { amount: 0, currency: pricing?.currency ?? 'CNY', priced: 0, unpriced: 0 },
    cursor: 0,
    upstreamErrors: 0,
  }

  function nextFault(callIndex) {
    for (const f of state.faults) {
      const at = typeof f.at === 'number' ? f.at : null
      const times = f.times ?? 1
      if (f.fired >= times) continue
      if (at !== null && at !== callIndex) continue
      f.fired += 1
      return f
    }
    return null
  }

  function resolveMockReply(ctx) {
    const script = state.script ?? {}
    // 指令精炼是内核在执行前多出的一次调用，必须排除在剧本序号之外：
    // 评测语料本身就是结构化任务书，真实模型在这一步会判 SKIP；若让它消耗剧本，
    // 后面每条回复都会整体错位——第 1 条（write_file 修复）被精炼吃掉，主循环只拿到一段纯文本，
    // 于是「一步都不动手」，看起来像能力退化，实际是装置错位。
    if (ctx.prompt.includes(REFINER_MARK)) {
      return normalizeReply({ content: 'SKIP:评测语料已是结构化指令，无需改写' }, '')
    }
    for (const rule of script.rules ?? []) {
      if (matchRule(rule.when, ctx)) return normalizeReply(rule.reply ?? rule, script.fallback?.content ?? '')
    }
    const plan = script.plan ?? []
    if (state.cursor < plan.length) {
      const reply = normalizeReply(plan[state.cursor], script.fallback?.content ?? '')
      state.cursor += 1
      return reply
    }
    return normalizeReply(script.fallback ?? { content: '任务已完成。' }, '任务已完成。')
  }

  // mock 回包里的 model 字段回填请求里的模型名，避免被测方因模型名不匹配而报错
  function toOpenAiBody(reply, callIndex, model) {
    const toolCalls = (reply.toolCalls ?? []).map((tc, idx) => ({
      id: `call_${callIndex}_${idx}`,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments ?? {}),
      },
    }))
    const usage = reply.usage ?? DEFAULT_USAGE
    return {
      id: `chatcmpl-mock-${callIndex}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: reply.content ?? '',
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
          },
          finish_reason: reply.finishReason ?? 'stop',
        },
      ],
      usage,
    }
  }

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf-8')
    const callIndex = state.requests.length + 1
    const startedAt = Date.now()

    let parsed = null
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      /* 记录为无 body 请求 */
    }
    const model = parsed?.model ?? 'unknown'
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
    const prompt = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
      .join('\n')

    const record = {
      seq: callIndex,
      ts: startedAt,
      path: req.url,
      model,
      messageCount: messages.length,
      toolCount: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
      promptChars: prompt.length,
      promptDigest: digest(prompt),
      stream: Boolean(parsed?.stream),
      auth: maskAuth(req.headers.authorization),
      status: 0,
      latencyMs: 0,
      fault: null,
      usage: null,
      cost: null,
    }
    state.requests.push(record)

    if (!req.url?.startsWith('/v1/chat/completions')) {
      record.status = 404
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `unsupported path: ${req.url}` } }))
      return
    }

    const fault = nextFault(callIndex)
    record.fault = fault ? { kind: fault.kind, at: fault.at ?? null } : null

    /** 故障注入优先于一切上游行为。 */
    if (fault) {
      if (fault.kind === 'http500' || fault.kind === 'http503') {
        const status = fault.kind === 'http500' ? 500 : 503
        record.status = status
        record.latencyMs = Date.now() - startedAt
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'injected upstream failure', type: 'injected' } }))
        return
      }
      if (fault.kind === 'disconnect') {
        // 连接中断：不写响应直接销毁套接字（考察 Harness 是否能优雅失败且不污染状态）
        record.status = -1
        record.latencyMs = Date.now() - startedAt
        state.errors.push({ seq: callIndex, kind: 'disconnect' })
        res.destroy()
        return
      }
      if (fault.kind === 'hang') {
        const ms = Number(fault.ms ?? 30_000)
        await new Promise((r) => setTimeout(r, ms))
        record.status = -2
        record.latencyMs = Date.now() - startedAt
        state.errors.push({ seq: callIndex, kind: 'hang', ms })
        res.destroy()
        return
      }
      if (fault.kind === 'malformed') {
        record.status = 200
        record.latencyMs = Date.now() - startedAt
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"choices": [{"message": {"role": "assistant", "content": "未闭合的 JSON')
        return
      }
      if (fault.kind === 'dirty') {
        const dirty = '\uFFFD\uFFFD\u0000{"broken": ,,,\n\u0007 交付完成 <<<>>> \uFFFD'
        const body = toOpenAiBody({ content: dirty, finishReason: 'stop' }, callIndex, model)
        record.status = 200
        record.usage = body.usage
        record.latencyMs = Date.now() - startedAt
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
        return
      }
    }

    // ---- record 模式：转发真实上游并记录 usage ----
    if (mode === 'record') {
      if (!upstream?.baseUrl) {
        record.status = 502
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'record 模式缺少 upstream.baseUrl' } }))
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs)
      try {
        const url = `${upstream.baseUrl.replace(/\/$/, '')}/chat/completions`
        const upstreamRes = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
          body: rawBody,
          signal: controller.signal,
        })
        record.status = upstreamRes.status
        const isStream = String(upstreamRes.headers.get('content-type') ?? '').includes('event-stream')
        if (isStream && upstreamRes.body) {
          res.writeHead(upstreamRes.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          const reader = upstreamRes.body.getReader()
          let tail = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const buf = Buffer.from(value)
            tail = (tail + buf.toString('utf-8')).slice(-65_536)
            res.write(buf)
          }
          res.end()
          const usage = extractUsageFromSse(tail)
          if (usage) recordUsage(record, usage, model)
        } else {
          const text = await upstreamRes.text()
          res.writeHead(upstreamRes.status, { 'content-type': 'application/json' })
          res.end(text)
          try {
            const json = JSON.parse(text)
            if (json?.usage) recordUsage(record, json.usage, model)
          } catch {
            /* 上游返回非 JSON（错误页等），已记录状态码 */
          }
        }
      } catch (err) {
        state.upstreamErrors += 1
        record.status = -3
        record.error = err instanceof Error ? err.message : String(err)
        if (!res.headersSent) {
          res.writeHead(504, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `upstream error: ${record.error}` } }))
        } else {
          res.destroy()
        }
      } finally {
        clearTimeout(timer)
        record.latencyMs = Date.now() - startedAt
      }
      return
    }

    // ---- mock 模式：本地剧本应答 ----
    const reply = resolveMockReply({ prompt, toolCount: record.toolCount, callIndex, model })
    if (reply.delayMs > 0) await new Promise((r) => setTimeout(r, reply.delayMs))
    if (reply.http) {
      record.status = reply.http.status ?? 500
      record.latencyMs = Date.now() - startedAt
      res.writeHead(record.status, { 'content-type': 'application/json' })
      res.end(typeof reply.http.body === 'string' ? reply.http.body : JSON.stringify(reply.http.body ?? {}))
      return
    }
    const body = toOpenAiBody(reply, callIndex, model)
    record.status = 200
    record.usage = body.usage
    record.latencyMs = Date.now() - startedAt
    recordUsage(record, body.usage, model)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(reply.raw ?? JSON.stringify(body))
  })

  function recordUsage(record, usage, model) {
    const normalized = {
      prompt_tokens: Number(usage.prompt_tokens ?? 0),
      completion_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
      prompt_cache_hit_tokens: Number(usage.prompt_cache_hit_tokens ?? 0),
      prompt_cache_miss_tokens: Number(usage.prompt_cache_miss_tokens ?? 0),
    }
    record.usage = normalized
    state.usage.prompt_tokens += normalized.prompt_tokens
    state.usage.completion_tokens += normalized.completion_tokens
    state.usage.total_tokens += normalized.total_tokens
    state.usage.prompt_cache_hit_tokens += normalized.prompt_cache_hit_tokens
    state.usage.calls += 1
    state.usage.reportedCalls += 1
    const cost = computeCost(normalized, pricing, model)
    record.cost = cost
    if (cost) {
      state.cost.amount += cost.amount
      state.cost.priced += 1
    } else {
      state.cost.unpriced += 1
    }
  }

  await new Promise((resolve) => server.listen(opts.port ?? 0, host, resolve))
  const port = server.address().port

  return {
    port,
    host,
    origin: `http://${host}:${port}`,
    baseUrl: `http://${host}:${port}/v1`,
    state,
    setScript(script) {
      state.script = script
      state.cursor = 0
    },
    setFaults(faults) {
      state.faults = (faults ?? []).map((f) => ({ ...f, fired: 0 }))
    },
    reset() {
      state.requests = []
      state.errors = []
      state.upstreamErrors = 0
      state.cursor = 0
      state.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, calls: 0, reportedCalls: 0 }
      state.cost = { amount: 0, currency: pricing?.currency ?? 'CNY', priced: 0, unpriced: 0 }
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** 从 SSE 尾部片段里提取 usage（流式转发时的成本采集）。 */
export function extractUsageFromSse(text) {
  const matches = [...text.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)]
  if (matches.length === 0) return null
  try {
    return JSON.parse(matches[matches.length - 1][1])
  } catch {
    return null
  }
}
