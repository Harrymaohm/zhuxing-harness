/**
 * 遥测（OpenTelemetry GenAI 语义约定）行为测试。
 *
 * 规范依据见 `src/plugin-domains/telemetry.ts` 文件头：semantic-conventions-genai（Development）
 * + OTLP 1.11.0。这些断言钉住的是「属性名与类型」与运维约束（默认关、不拖累主链路、隐私底线），
 * 规范一旦演进，这里应当先红再改。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { createHarness } from '@zhuxing/harness-kernel'
import type { Logger } from '@zhuxing/harness-kernel'
import type { ToolDefinition, ToolRegistry } from '@zhuxing/harness-tools'
import {
  buildInferenceSpan,
  buildOtlpTracesRequest,
  buildToolSpan,
  formatModelMetricsLine,
  msToUnixNano,
  NO_SAMPLE_NOTE,
  OtlpSpanExporter,
  randomHex,
  resolveTelemetryConfig,
  SpanBuffer,
  telemetryPlugins,
  toMetricsView,
  toOtlpAttributeValue,
} from '../src/index.js'
import type { GenAiSpan, ModelMetricsView, TelemetryStats } from '../src/index.js'
import { modelRouterPlugins } from '../src/plugin-domains/model-router.js'
import { baseBundlePlugins } from '../src/index.js'
import type { ModelMetrics } from '@zhuxing/harness-model-router'

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 最小 span（缓冲/导出器单测用）。 */
function sampleSpan(): GenAiSpan {
  return buildToolSpan({
    traceId: randomHex(16),
    spanId: randomHex(8),
    startTimeUnixNano: msToUnixNano(1000),
    endTimeUnixNano: msToUnixNano(1010),
    toolName: 'read_file',
  })
}

/** 本地 collector stub：记录收到的请求，便于逐条断言。 */
interface ReceivedRequest {
  url: string
  method: string
  contentType: string
  body: string
}

async function startCollectorStub(): Promise<{ port: number; received: ReceivedRequest[]; close: () => Promise<void> }> {
  const received: ReceivedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        method: req.method ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf-8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 从 OTLP/JSON body 里取出全部 span。 */
function spansOf(body: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(body) as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> }
  return (parsed.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []))
}

/** 把 OTLP/JSON 的属性数组拍平成 key → value。 */
function attrsOf(span: Record<string, unknown>): Record<string, unknown> {
  const list = (span.attributes ?? []) as Array<{ key: string; value: unknown }>
  return Object.fromEntries(list.map((a) => [a.key, a.value]))
}

const envKeys = ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME', 'OTEL_GENAI_CAPTURE_CONTENT']
afterEach(() => {
  for (const key of envKeys) delete process.env[key]
})

describe('GenAI span 形状（属性名与类型按语义约定）', () => {
  it('inference span：operation/provider/model/usage/conversation.id 齐备，input_tokens 含缓存命中', () => {
    const span = buildInferenceSpan({
      traceId: randomHex(16),
      spanId: randomHex(8),
      startTimeUnixNano: msToUnixNano(1_700_000_000_000),
      endTimeUnixNano: msToUnixNano(1_700_000_001_200),
      baseUrl: 'https://api.deepseek.com/v1',
      requestModel: 'deepseek-chat',
      responseModel: 'deepseek-chat-0613',
      conversationId: 'sess-42',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 800,
      finishReasons: ['stop'],
    })

    // span 名格式：`{gen_ai.operation.name} {gen_ai.request.model}`
    expect(span.name).toBe('chat deepseek-chat')
    expect(span.kind).toBe('SPAN_KIND_CLIENT')
    // Required
    expect(span.attributes['gen_ai.operation.name']).toBe('chat')
    expect(span.attributes['gen_ai.provider.name']).toBe('deepseek')
    // Conditionally Required / Recommended
    expect(span.attributes['gen_ai.request.model']).toBe('deepseek-chat')
    expect(span.attributes['gen_ai.response.model']).toBe('deepseek-chat-0613')
    expect(span.attributes['gen_ai.conversation.id']).toBe('sess-42')
    expect(span.attributes['gen_ai.response.finish_reasons']).toEqual(['stop'])
    // token 数是 int（input 已包含 800 缓存命中）
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(1200)
    expect(Number.isInteger(span.attributes['gen_ai.usage.input_tokens'])).toBe(true)
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(300)
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(800)
    // 成功路径：无 error.type，status 为 OK
    expect(span.attributes['error.type']).toBeUndefined()
    expect(span.status.code).toBe('STATUS_CODE_OK')
  })

  it('inference span：失败时写 error.type 且 status=ERROR', () => {
    const span = buildInferenceSpan({
      traceId: randomHex(16),
      spanId: randomHex(8),
      startTimeUnixNano: msToUnixNano(1),
      endTimeUnixNano: msToUnixNano(2),
      providerName: 'openai',
      requestModel: 'gpt-4',
      errorType: 'timeout',
      errorMessage: 'read timeout',
    })
    expect(span.attributes['error.type']).toBe('timeout')
    expect(span.status).toEqual({ code: 'STATUS_CODE_ERROR', message: 'read timeout' })
  })

  it('execute_tool span：Required 的 operation.name/tool.name + Recommended type/agent', () => {
    const span = buildToolSpan({
      traceId: randomHex(16),
      spanId: randomHex(8),
      startTimeUnixNano: msToUnixNano(100),
      endTimeUnixNano: msToUnixNano(140),
      toolName: 'write_file',
      conversationId: 'sess-7',
      agentName: 'zhuxing-harness',
    })
    expect(span.name).toBe('execute_tool write_file')
    expect(span.kind).toBe('SPAN_KIND_INTERNAL')
    expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool')
    expect(span.attributes['gen_ai.tool.name']).toBe('write_file')
    expect(span.attributes['gen_ai.tool.type']).toBe('function')
    expect(span.attributes['gen_ai.agent.name']).toBe('zhuxing-harness')
    expect(span.attributes['gen_ai.conversation.id']).toBe('sess-7')
    expect(span.status.code).toBe('STATUS_CODE_OK')

    const failed = buildToolSpan({
      traceId: randomHex(16),
      spanId: randomHex(8),
      startTimeUnixNano: msToUnixNano(100),
      endTimeUnixNano: msToUnixNano(140),
      toolName: 'shell',
      errorType: 'tool_execution_error',
      errorMessage: 'boom',
    })
    expect(failed.attributes['error.type']).toBe('tool_execution_error')
    expect(failed.status.code).toBe('STATUS_CODE_ERROR')
  })

  it('OTLP/JSON 值编码：int64 → 字符串、traceId/spanId → 十六进制（非 base64）', () => {
    expect(toOtlpAttributeValue('x')).toEqual({ stringValue: 'x' })
    expect(toOtlpAttributeValue(true)).toEqual({ boolValue: true })
    expect(toOtlpAttributeValue(42)).toEqual({ intValue: '42' })
    expect(toOtlpAttributeValue(1.5)).toEqual({ doubleValue: 1.5 })
    expect(toOtlpAttributeValue(['a', 'b'])).toEqual({ arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } })

    const encoded = spansOf(
      JSON.stringify(buildOtlpTracesRequest([sampleSpan()], { serviceName: 'zhuxing-harness' })),
    )[0]
    expect(encoded.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(encoded.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof encoded.startTimeUnixNano).toBe('string')
    expect(typeof encoded.endTimeUnixNano).toBe('string')
    expect(String(encoded.startTimeUnixNano)).toMatch(/^\d+$/)
    // 属性形状：{key, value:{...}}
    expect(attrsOf(encoded)['gen_ai.operation.name']).toEqual({ stringValue: 'execute_tool' })
  })
})

describe('端点解析（生态惯例优先级）', () => {
  it('信号级 > 基础端点 > 显式；三处都无 → 关闭', () => {
    expect(resolveTelemetryConfig({}, undefined)).toBeUndefined()
    expect(resolveTelemetryConfig({}, '  ')).toBeUndefined()
    // 基础端点补 /v1/traces（含尾部斜杠归一）
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/' })?.endpoint).toBe('http://c:4318/v1/traces')
    // 信号级端点按原样使用
    expect(
      resolveTelemetryConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://base:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://sig:4318/custom/traces',
      })?.endpoint,
    ).toBe('http://sig:4318/custom/traces')
    // 显式配置优先级最低
    expect(resolveTelemetryConfig({}, 'http://repo:4318')?.endpoint).toBe('http://repo:4318/v1/traces')
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env:4318' }, 'http://repo:4318')?.endpoint).toBe(
      'http://env:4318/v1/traces',
    )
  })

  it('service.name 与正文采集开关都来自环境变量，正文默认关闭', () => {
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })?.serviceName).toBe('zhuxing-harness')
    expect(
      resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SERVICE_NAME: 'my-svc' })?.serviceName,
    ).toBe('my-svc')
    expect(resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })?.captureContent).toBe(false)
    expect(
      resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_GENAI_CAPTURE_CONTENT: '1' })?.captureContent,
    ).toBe(true)
    expect(
      resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_GENAI_CAPTURE_CONTENT: '0' })?.captureContent,
    ).toBe(false)
  })
})

describe('默认关闭：零网络', () => {
  it('未配置端点时不发起任何 HTTP 请求，也不提供 telemetry 服务', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = createHarness({ logLevel: 'error', logger: silentLogger })
      await app.mount(telemetryPlugins({ env: {} })[0])
      // 事件照常派发：遥测插件即使在场也不出网
      expect(await app.events.emit('agent/pre-step', { sessionId: 'sess-1', step: 0 })).toBe(true)
      expect(await app.events.emit('tools/before-exec', { name: 'read_file', args: { path: 'a.ts' } })).toBe(true)
      expect(await app.events.emit('tools/after-exec', { name: 'read_file', result: { text: 'ok' } })).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(app.services.get('telemetry')).toBeUndefined()
      await app.dispose()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('配置端点后可导出（本地 collector stub）', () => {
  it('POST <endpoint>/v1/traces，body 是合法 OTLP/JSON', async () => {
    const stub = await startCollectorStub()
    try {
      const app = createHarness({ logLevel: 'error', logger: silentLogger })
      await app.mount(
        telemetryPlugins({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${stub.port}` }, flushIntervalMs: 60_000 })[0],
      )
      await app.events.emit('tools/before-exec', { name: 'write_file', args: { path: 'x.txt' }, sessionId: 'sess-42', callId: 'call-1' })
      await app.events.emit('tools/after-exec', {
        name: 'write_file',
        result: { text: '已写入' },
        sessionId: 'sess-42',
        callId: 'call-1',
        durationMs: 5,
        ok: true,
      })
      // 卸载时 flush 待导出 span
      await app.dispose()

      expect(stub.received).toHaveLength(1)
      expect(stub.received[0].method).toBe('POST')
      expect(stub.received[0].url).toBe('/v1/traces')
      expect(stub.received[0].contentType).toContain('application/json')

      const body = JSON.parse(stub.received[0].body) as {
        resourceSpans: Array<{ resource: { attributes: unknown[] }; scopeSpans: Array<{ scope: { name: string }; spans: unknown[] }> }>
      }
      expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
      expect(body.resourceSpans[0].scopeSpans[0].scope.name).toBe('zhuxing-harness/genai')
      const span = spansOf(stub.received[0].body)[0]
      expect(span.name).toBe('execute_tool write_file')
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(typeof span.startTimeUnixNano).toBe('string')
      const attrs = attrsOf(span)
      expect(attrs['gen_ai.operation.name']).toEqual({ stringValue: 'execute_tool' })
      expect(attrs['gen_ai.tool.name']).toEqual({ stringValue: 'write_file' })
      expect(attrs['gen_ai.conversation.id']).toEqual({ stringValue: 'sess-42' })
      expect(span.status).toEqual({ code: 'STATUS_CODE_OK' })
    } finally {
      await stub.close()
    }
  })

  it('collector 不可达：调用方正常完成、无未捕获异常，失败被计数', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const app = createHarness({ logLevel: 'error', logger: silentLogger })
      // 指向必然拒绝连接的地址（127.0.0.1:1）
      await app.mount(telemetryPlugins({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' } })[0])
      const telemetry = app.services.get<{ flush: () => Promise<void>; stats: () => TelemetryStats }>('telemetry')!
      // 模拟 agent 流程：事件派发全部成功（监听器绝不返回 false 拖住主链路）
      expect(await app.events.emit('tools/before-exec', { name: 'shell', args: { command: 'echo 1' } })).toBe(true)
      expect(await app.events.emit('tools/after-exec', { name: 'shell', result: { text: '1' } })).toBe(true)
      await telemetry.flush()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(telemetry.stats().failed).toBeGreaterThan(0)
      expect(unhandled).toHaveLength(0)
      await app.dispose()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('缓冲有界：灌入超过上限的 span，只保留上限条并计数丢弃', async () => {
    const buffer = new SpanBuffer(3)
    for (let i = 0; i < 5; i++) buffer.add(sampleSpan())
    expect(buffer.size).toBe(3)
    expect(buffer.dropped).toBe(2)

    // 经由导出器同样有界（pending 不超过上限）
    const exporter = new OtlpSpanExporter({
      endpoint: 'http://127.0.0.1:1/v1/traces',
      serviceName: 'zhuxing-harness',
      bufferLimit: 3,
      logger: silentLogger,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    for (let i = 0; i < 7; i++) exporter.add(sampleSpan())
    expect(exporter.stats().pending).toBe(3)
    expect(exporter.stats().dropped).toBe(4)
    await exporter.flush()
    expect(exporter.stats().exported).toBe(3)
  })

  it('插件卸载（dispose）时 flush 待导出 span', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const app = createHarness({ logLevel: 'error', logger: silentLogger })
    await app.mount(
      telemetryPlugins({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid' },
        // 导出间隔设得很长：证明 span 是「卸载时 flush」送出的，而不是定时器
        flushIntervalMs: 60_000,
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), body: String(init?.body ?? '') })
          return new Response('{}', { status: 200 })
        },
      })[0],
    )
    await app.events.emit('tools/before-exec', { name: 'read_file', args: { path: 'x' } })
    await app.events.emit('tools/after-exec', { name: 'read_file', result: { text: 'ok' } })
    expect(calls).toHaveLength(0)

    await app.unmount('harness-telemetry')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://collector.invalid/v1/traces')
    expect(spansOf(calls[0].body)[0].name).toBe('execute_tool read_file')
  })
})

describe('隐私底线：正文属性', () => {
  const FAKE_KEY = 'sk-abcdefghijklmnopqrst'

  async function runToolOnce(captureContent: boolean): Promise<string> {
    const bodies: string[] = []
    const app = createHarness({ logLevel: 'error', logger: silentLogger })
    await app.mount(
      telemetryPlugins({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid' },
        captureContent,
        flushIntervalMs: 60_000,
        fetchImpl: async (_input, init) => {
          bodies.push(String(init?.body ?? ''))
          return new Response('{}', { status: 200 })
        },
      })[0],
    )
    await app.events.emit('tools/before-exec', { name: 'read_file', args: { path: '.env', apiKey: FAKE_KEY } })
    await app.events.emit('tools/after-exec', { name: 'read_file', result: { text: `DEEPSEEK_API_KEY=${FAKE_KEY}` } })
    await app.unmount('harness-telemetry')
    expect(bodies).toHaveLength(1)
    return bodies[0]
  }

  it('默认不采集工具参数与结果正文（且凭据绝不出现）', async () => {
    const body = await runToolOnce(false)
    expect(body).not.toContain('gen_ai.tool.call.arguments')
    expect(body).not.toContain('gen_ai.tool.call.result')
    expect(body).not.toContain(FAKE_KEY)
  })

  it('显式开启后采集正文，但必须先经脱敏（假 key 被掩码）', async () => {
    const body = await runToolOnce(true)
    expect(body).toContain('gen_ai.tool.call.arguments')
    expect(body).toContain('gen_ai.tool.call.result')
    expect(body).not.toContain(FAKE_KEY)
    expect(body).toContain('[REDACTED]')
  })
})

describe('模型指标展示：区分「尚无采样」与「真实为 0」', () => {
  const emptyMetrics: ModelMetrics = {
    calls: 0,
    ok: 0,
    fail: 0,
    successRate: 1,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    totalTokens: 0,
    estCost: 0,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    cacheHitRate: 0,
  }
  const sampledMetrics: ModelMetrics = {
    calls: 3,
    ok: 2,
    fail: 1,
    successRate: 2 / 3,
    avgLatencyMs: 812,
    p95LatencyMs: 1_500,
    totalTokens: 1_234,
    estCost: 0.0012,
    totalCacheHitTokens: 800,
    totalCacheMissTokens: 400,
    cacheHitRate: 2 / 3,
    lastError: 'boom',
  }

  it('无采样：数值字段为 null，文案是「暂无采样」而不是 0% / 100% / 0ms', () => {
    const view = toMetricsView(emptyMetrics)
    expect(view.sampled).toBe(false)
    expect(view.note).toBe(NO_SAMPLE_NOTE)
    expect(view.calls).toBe(0)
    expect(view.successRatePct).toBeNull()
    expect(view.avgLatencyMs).toBeNull()
    expect(view.estCost).toBeNull()

    const line = formatModelMetricsLine(emptyMetrics)
    expect(line).toContain(NO_SAMPLE_NOTE)
    // 展示层不得再把「尚无采样」渲染成性能数字（monitor 无数据时 successRate 为 1，尤其容易误导）
    expect(line).not.toContain('100%')
    expect(line).not.toContain('0%')
    expect(line).not.toContain('ms')
  })

  it('有采样：给出真实数值；「真实为 0%」与「无采样」互不混淆', () => {
    const view = toMetricsView(sampledMetrics)
    expect(view.sampled).toBe(true)
    expect(view.successRatePct).toBe(67)
    expect(view.avgLatencyMs).toBe(812)
    expect(formatModelMetricsLine(sampledMetrics)).toContain('成功率 67%')
    expect(formatModelMetricsLine(sampledMetrics)).toContain('调用 3 次')

    const allFail: ModelMetrics = { ...sampledMetrics, calls: 2, ok: 0, fail: 2, successRate: 0 }
    expect(formatModelMetricsLine(allFail)).toContain('成功率 0%')
    expect(formatModelMetricsLine(allFail)).not.toContain(NO_SAMPLE_NOTE)
  })

  it('list_models 工具输出两态：无采样 sampled=false + note，有数据才给数值', async () => {
    const tools = new Map<string, ToolDefinition>()
    const services = new Map<string, unknown>()
    const llm: ChatProvider = {
      name: 'fake',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        void messages
        return { content: '', toolCalls: [], finishReason: 'stop' }
      },
    }
    const fakeCtx = {
      config: {},
      inject: (name: string) =>
        name === 'llm'
          ? llm
          : {
              register: (def: ToolDefinition) => {
                tools.set(def.name, def)
                return () => {
                  tools.delete(def.name)
                }
              },
            },
      injectOptional: () => undefined,
      provide: (name: string, impl: unknown) => {
        services.set(name, impl)
      },
      effect: () => {},
      logger: silentLogger,
    }
    const def = modelRouterPlugins({ apiKey: 'k', model: 'main-model' })[0]
    def.apply(fakeCtx as never)

    const listModels = tools.get('list_models')!
    const first = (await listModels.execute!({}, {} as never)) as { json: Array<{ metrics: ModelMetricsView }> }
    expect(first.json[0].metrics.sampled).toBe(false)
    expect(first.json[0].metrics.note).toBe(NO_SAMPLE_NOTE)
    expect(first.json[0].metrics.successRatePct).toBeNull()
    expect(first.json[0].metrics.avgLatencyMs).toBeNull()

    // 记录一次真实调用后，指标转为有数据
    const monitor = services.get('modelMonitor') as { record: (call: unknown) => void }
    monitor.record({ modelId: 'default', ok: true, latencyMs: 100, promptTokens: 10, completionTokens: 5, ts: Date.now() })
    const second = (await listModels.execute!({}, {} as never)) as { json: Array<{ metrics: ModelMetricsView }> }
    expect(second.json[0].metrics.sampled).toBe(true)
    expect(second.json[0].metrics.successRatePct).toBe(100)
    expect(second.json[0].metrics.calls).toBe(1)
  })
})

describe('真实链路：base bundle + Agent 一轮 → collector stub 收到 span', () => {
  /** 与 tests/e2e.test.ts 同构的假模型：精炼返回 SKIP、调用 hello 工具、校验放行。 */
  function makeFakeProvider(): ChatProvider {
    return {
      name: 'fake',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        const sys = typeof messages[0]?.content === 'string' ? messages[0].content : ''
        if (sys.includes('任务指令精炼器')) return { content: 'SKIP：固定测试桩不拆解', toolCalls: [], finishReason: 'stop' }
        if (sys.includes('任务完成度校验器')) return { content: 'OK', toolCalls: [], finishReason: 'stop' }
        if (messages.some((m) => m.role === 'tool')) {
          return { content: '闭环跑通：你好，遥测测试！', toolCalls: [], finishReason: 'stop' }
        }
        return {
          content: '',
          toolCalls: [{ id: 'c1', name: 'hello', arguments: '{"name":"遥测测试"}' }],
          finishReason: 'tool_calls',
        }
      },
    }
  }

  it('设置 OTEL_EXPORTER_OTLP_ENDPOINT 后，真实一轮 Agent 的工具调用被导出', async () => {
    const stub = await startCollectorStub()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${stub.port}`
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-telemetry-'))
      const app = createHarness({ logLevel: 'error', logger: silentLogger })
      for (const plugin of baseBundlePlugins({
        apiKey: 'sk-test',
        model: 'fake-model',
        workspace,
        level: 'workspace-write',
        memoryPath: join(workspace, 'memories.json'),
        verifyGoal: async () => ({ ok: true }),
      })) {
        await app.mount(plugin, { config: plugin.name === 'harness-llm' ? { provider: makeFakeProvider() } : undefined })
      }
      const tools = app.pluginManager.get('harness-tools')!.ctx.inject<ToolRegistry>('tools')
      tools.register({
        name: 'hello',
        description: '打招呼',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
        execute: async (args) => ({ text: `你好，${String(args.name ?? '')}` }),
      })

      const agent = app.pluginManager.get('harness-agent')!.ctx.inject<{ run: (task: string) => Promise<{ sessionId: string; finishedReason: string }> }>('agent')
      const result = await agent.run('用 hello 工具打个招呼')
      expect(result.finishedReason).toBe('stop')

      await app.dispose()

      const spans = stub.received.flatMap((req) => spansOf(req.body))
      const toolSpan = spans.find((s) => s.name === 'execute_tool hello')
      expect(toolSpan).toBeDefined()
      const attrs = attrsOf(toolSpan!)
      expect(attrs['gen_ai.operation.name']).toEqual({ stringValue: 'execute_tool' })
      expect(attrs['gen_ai.tool.name']).toEqual({ stringValue: 'hello' })
      expect(attrs['gen_ai.tool.type']).toEqual({ stringValue: 'function' })
      expect(attrs['gen_ai.agent.name']).toEqual({ stringValue: 'zhuxing-harness' })
      // 会话关联：span 上的 conversation.id 就是本轮会话 id
      expect(attrs['gen_ai.conversation.id']).toEqual({ stringValue: result.sessionId })
      expect(toolSpan!.status).toEqual({ code: 'STATUS_CODE_OK' })
    } finally {
      await stub.close()
    }
  })
})

describe('真实链路：chat（inference）span', () => {
  /** 假 provider：成功时返回 usage + raw.model（模拟 OpenAI 兼容响应体自带 model）；fail 时抛错。 */
  function makeChatProvider(opts: { fail?: boolean; toolCall?: boolean } = {}): ChatProvider {
    const usage = { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cacheHitTokens: 800, cacheMissTokens: 400 }
    return {
      name: 'fake-chat',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        if (opts.fail) throw new Error('模型请求失败（HTTP 500）：上游不可用')
        const alreadyCalledTool = messages.some((m) => m.role === 'tool')
        if (opts.toolCall && !alreadyCalledTool) {
          return {
            content: '',
            toolCalls: [{ id: `c-${Math.random().toString(36).slice(2)}`, name: 'ping', arguments: '{}' }],
            finishReason: 'tool_calls',
            usage,
            raw: { model: 'fake-model-0613' },
          }
        }
        return { content: '直接回答：4', toolCalls: [], finishReason: 'stop', usage, raw: { model: 'fake-model-0613' } }
      },
    }
  }

  interface AgentService {
    run: (input: string, sessionId?: string) => Promise<{ sessionId: string; finishedReason: string }>
  }

  /** 挂载基础 bundle（关闭精炼、校验固定放行），并把假 provider 注入 harness-llm。 */
  async function mountBundle(provider: ChatProvider, workspace: string) {
    const app = createHarness({ logLevel: 'error', logger: silentLogger })
    for (const plugin of baseBundlePlugins({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'fake-model',
      workspace,
      level: 'workspace-write',
      memoryPath: join(workspace, 'memories.json'),
      refineInstruction: false,
      verifyGoal: async () => ({ ok: true }),
    })) {
      await app.mount(plugin, { config: plugin.name === 'harness-llm' ? { provider } : undefined })
    }
    return app
  }

  it('成功一轮：产出 `chat <model>` span，含 usage / 缓存命中 / 会话关联', async () => {
    const stub = await startCollectorStub()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${stub.port}`
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-telemetry-chat-'))
      const app = await mountBundle(makeChatProvider(), workspace)
      const agent = app.pluginManager.get('harness-agent')!.ctx.inject<AgentService>('agent')
      const result = await agent.run('直接回答这个问题')
      expect(result.finishedReason).toBe('stop')
      await app.dispose()

      const chat = stub.received.flatMap((req) => spansOf(req.body)).find((s) => String(s.name).startsWith('chat '))
      expect(chat).toBeDefined()
      expect(chat!.name).toBe('chat fake-model')
      expect(chat!.kind).toBe('SPAN_KIND_CLIENT')
      const attrs = attrsOf(chat!)
      expect(attrs['gen_ai.operation.name']).toEqual({ stringValue: 'chat' })
      // provider.name 由 baseUrl 推断（Required 属性）
      expect(attrs['gen_ai.provider.name']).toEqual({ stringValue: 'deepseek' })
      expect(attrs['gen_ai.request.model']).toEqual({ stringValue: 'fake-model' })
      expect(attrs['gen_ai.response.model']).toEqual({ stringValue: 'fake-model-0613' })
      expect(attrs['gen_ai.usage.input_tokens']).toEqual({ intValue: '1200' })
      expect(attrs['gen_ai.usage.output_tokens']).toEqual({ intValue: '300' })
      expect(attrs['gen_ai.usage.cache_read.input_tokens']).toEqual({ intValue: '800' })
      expect(attrs['gen_ai.response.finish_reasons']).toEqual({ arrayValue: { values: [{ stringValue: 'stop' }] } })
      expect(attrs['gen_ai.conversation.id']).toEqual({ stringValue: result.sessionId })
      expect(chat!.status).toEqual({ code: 'STATUS_CODE_OK' })
    } finally {
      await stub.close()
    }
  })

  it('失败路径：产出 status=ERROR 且带 error.type 的 chat span', async () => {
    const stub = await startCollectorStub()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${stub.port}`
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-telemetry-chat-fail-'))
      const app = await mountBundle(makeChatProvider({ fail: true }), workspace)
      const agent = app.pluginManager.get('harness-agent')!.ctx.inject<AgentService>('agent')
      const result = await agent.run('直接回答这个问题')
      expect(result.finishedReason).toBe('error')
      await app.dispose()

      const chat = stub.received.flatMap((req) => spansOf(req.body)).find((s) => String(s.name).startsWith('chat '))
      expect(chat).toBeDefined()
      expect(chat!.name).toBe('chat fake-model')
      expect(chat!.status).toEqual({ code: 'STATUS_CODE_ERROR', message: '模型请求失败（HTTP 500）：上游不可用' })
      const attrs = attrsOf(chat!)
      expect(attrs['gen_ai.operation.name']).toEqual({ stringValue: 'chat' })
      expect(attrs['error.type']).toEqual({ stringValue: 'http_error' })
    } finally {
      await stub.close()
    }
  })

  it('两个并发会话：工具 span 的 conversation.id 各自正确（会话关联不再是 best-effort）', async () => {
    const stub = await startCollectorStub()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${stub.port}`
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-telemetry-concurrent-'))
      const app = await mountBundle(makeChatProvider({ toolCall: true }), workspace)
      const tools = app.pluginManager.get('harness-tools')!.ctx.inject<ToolRegistry>('tools')
      tools.register({
        name: 'ping',
        description: '探活',
        schema: { type: 'object', properties: {} },
        execute: () => ({ text: 'pong' }),
      })
      const sessions = app.pluginManager
        .get('harness-session')!
        .ctx.inject<{ create: () => Promise<{ id: string }> }>('sessionService')
      const first = await sessions.create()
      const second = await sessions.create()
      const agent = app.pluginManager.get('harness-agent')!.ctx.inject<AgentService>('agent')

      const results = await Promise.all([agent.run('用 ping 工具探活', first.id), agent.run('用 ping 工具探活', second.id)])
      expect(results.map((r) => r.finishedReason)).toEqual(['stop', 'stop'])
      await app.dispose()

      const spans = stub.received.flatMap((req) => spansOf(req.body)).filter((s) => s.name === 'execute_tool ping')
      expect(spans).toHaveLength(2)
      const convIds = spans
        .map((s) => (attrsOf(s)['gen_ai.conversation.id'] as { stringValue: string }).stringValue)
        .sort()
      expect(convIds).toEqual([first.id, second.id].sort())
      // 每次调用都带自己的 tool.call.id（而非同名 FIFO 猜测出来的）
      const callIds = spans.map((s) => (attrsOf(s)['gen_ai.tool.call.id'] as { stringValue: string }).stringValue)
      expect(new Set(callIds).size).toBe(2)
    } finally {
      await stub.close()
    }
  })
})
