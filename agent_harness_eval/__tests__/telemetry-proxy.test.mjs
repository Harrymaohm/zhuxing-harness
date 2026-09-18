/**
 * 网络层遥测代理的单元测试。
 *
 * 代理是「真实成本」与「故障注入」两条证据链的唯一来源，所以这里钉住三件事：
 * 1. 缺费率必须返回 null（未知不是 0 元）；
 * 2. 剧本游标与故障计数的语义（故障按 1-based 绝对 callIndex 命中，且不消耗游标）；
 * 3. 凭据只留摘要与长度，明文永不进账本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CANARY_API_KEY, computeCost, startTelemetryProxy } from '../src/telemetry-proxy.mjs'

const PRICING = { currency: 'CNY', unit: 1_000_000, source: 'unit-test', models: { 'deepseek-v4-flash': { input: 2, output: 8 } } }

async function chat(baseUrl, { tools, model = 'deepseek-v4-flash', auth = 'Bearer unit-test' } = {}) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...(tools ? { tools } : {}) }),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    // 故障注入（malformed）下响应不可解析，这是预期行为
  }
  return { status: res.status, body }
}

const TOOLS = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]

test('computeCost：缺费率返回 null，而不是伪造 0 元', () => {
  assert.equal(computeCost({ prompt_tokens: 100 }, PRICING, 'unknown-model'), null)
  assert.equal(computeCost({ prompt_tokens: 100 }, { models: { m: { output: 8 } } }, 'm'), null)
  assert.equal(computeCost({ prompt_tokens: 100 }, undefined, 'deepseek-v4-flash'), null)
})

test('computeCost：unit 默认 100 万，缓存命中单独计价', () => {
  const plain = computeCost({ prompt_tokens: 1_000_000, completion_tokens: 0 }, PRICING, 'deepseek-v4-flash')
  assert.equal(plain.amount, 2)
  assert.equal(plain.currency, 'CNY')
  assert.equal(plain.unit, 1_000_000)
  assert.equal(plain.rate.output, 8)
  assert.equal(plain.rateSource, 'unit-test')

  const cached = computeCost(
    { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 0 },
    { unit: 1_000_000, models: { m: { input: 2, output: 8, cacheRead: 0.5 } } },
    'm',
  )
  assert.equal(cached.amount, 0.5)

  const custom = computeCost({ prompt_tokens: 1000, completion_tokens: 500 }, { unit: 1000, models: { m: { input: 3, output: 1 } } }, 'm')
  assert.equal(custom.amount, 3 + 0.5)
})

test('剧本语义：rules 优先、plan 按游标、耗尽后 fallback；故障按绝对 callIndex 命中且不消耗游标', async () => {
  const proxy = await startTelemetryProxy({
    script: {
      rules: [{ when: { hasTools: false }, reply: { content: 'OK' } }],
      plan: [{ content: 'first' }, { content: 'second' }],
      fallback: { content: 'done' },
    },
    faults: [{ at: 2, kind: 'http500' }],
    pricing: PRICING,
  })

  try {
    const first = await chat(proxy.baseUrl, { tools: TOOLS })
    assert.equal(first.status, 200)
    assert.equal(first.body.choices[0].message.content, 'first')
    assert.equal(first.body.model, 'deepseek-v4-flash')

    // 第 2 次调用命中故障：故障优先于剧本
    const faulted = await chat(proxy.baseUrl, { tools: TOOLS })
    assert.equal(faulted.status, 500)
    assert.match(faulted.body.error.message, /injected upstream failure/)

    // 故障不消耗计划游标 —— 第 3 次调用应当拿到 plan[1] 而不是被跳过
    const third = await chat(proxy.baseUrl, { tools: TOOLS })
    assert.equal(third.body.choices[0].message.content, 'second')

    const fourth = await chat(proxy.baseUrl, { tools: TOOLS })
    assert.equal(fourth.body.choices[0].message.content, 'done')

    // 不带 tools 的调用（目标校验器）命中规则，而不是继续消耗 plan
    const verify = await chat(proxy.baseUrl)
    assert.equal(verify.body.choices[0].message.content, 'OK')

    // 账本：只有成功的 mock 应答才计 usage 与成本
    assert.equal(proxy.state.requests.length, 5)
    assert.equal(proxy.state.requests[1].fault.kind, 'http500')
    assert.equal(proxy.state.usage.calls, 4)
    assert.equal(proxy.state.cost.priced, 4)
    assert.equal(proxy.state.cost.unpriced, 0)
    assert.equal(proxy.state.usage.total_tokens, 4 * 192)
    assert.ok(Math.abs(proxy.state.cost.amount - 0.003072) < 1e-12)
  } finally {
    await proxy.stop()
  }
})

test('reset 清零账本但不复活已烧掉的故障；setFaults 重新武装', async () => {
  const proxy = await startTelemetryProxy({
    script: { fallback: { content: 'again' } },
    faults: [{ at: 1, kind: 'http503' }],
    pricing: PRICING,
  })

  try {
    const fired = await chat(proxy.baseUrl)
    assert.equal(fired.status, 503)

    proxy.reset()
    assert.equal(proxy.state.requests.length, 0)
    assert.equal(proxy.state.usage.calls, 0)

    // fired 计数在 reset 之外保留，因此旧故障不会复活
    const afterReset = await chat(proxy.baseUrl)
    assert.equal(afterReset.status, 200)

    // 重新武装后按当前账本长度换算绝对 callIndex
    proxy.setFaults([{ at: proxy.state.requests.length + 1, kind: 'http503' }])
    const rearmed = await chat(proxy.baseUrl)
    assert.equal(rearmed.status, 503)
  } finally {
    await proxy.stop()
  }
})

test('malformed 注入返回不可解析的 200 响应', async () => {
  const proxy = await startTelemetryProxy({ script: { fallback: { content: 'x' } }, faults: [{ at: 1, kind: 'malformed' }] })
  try {
    const res = await chat(proxy.baseUrl)
    assert.equal(res.status, 200)
    assert.equal(res.body, null)
  } finally {
    await proxy.stop()
  }
})

test('disconnect 注入直接断开连接，客户端必须能观察到失败', async () => {
  const proxy = await startTelemetryProxy({ script: { fallback: { content: 'x' } }, faults: [{ at: 1, kind: 'disconnect' }] })
  try {
    await assert.rejects(() =>
      fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
      }),
    )
    assert.equal(proxy.state.errors.length, 1)
    assert.equal(proxy.state.errors[0].kind, 'disconnect')
  } finally {
    await proxy.stop()
  }
})

test('凭据只留摘要与长度：金丝雀可被识别，明文永不进账本', async () => {
  const proxy = await startTelemetryProxy({ script: { fallback: { content: 'ok' } } })
  try {
    await chat(proxy.baseUrl, { auth: `Bearer ${CANARY_API_KEY}` })
    const record = proxy.state.requests[0]

    assert.equal(record.auth.canary, true)
    assert.equal(record.auth.length, CANARY_API_KEY.length)
    assert.equal(record.auth.digest.length, 16)
    // 账本序列化后不得出现明文
    assert.equal(JSON.stringify(proxy.state.requests).includes(CANARY_API_KEY), false)
  } finally {
    await proxy.stop()
  }
})
