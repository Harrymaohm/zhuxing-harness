/**
 * 遥测插件域：按 OpenTelemetry **GenAI 语义约定**导出 trace（OTLP/JSON over HTTP）。
 *
 * ## 规范依据（抓取日期 2026-09-18）
 * - GenAI 语义约定已从主规范仓迁至 `open-telemetry/semantic-conventions-genai`（main 分支），
 *   文档状态为 **Development（非 stable）**——属性名与 span 名仍会演进，升级前需重新核对：
 *   - `docs/gen-ai/gen-ai-spans.md`（inference / execute tool span）
 *   - `docs/gen-ai/gen-ai-agent-spans.md`（agent / plan span）
 *   - `docs/gen-ai/gen-ai-events.md`、`model/gen-ai/registry.yaml`（属性枚举）
 *   本文件使用的属性：
 *   - inference span：`gen_ai.operation.name`=`chat`(Required)、`gen_ai.provider.name`(Required)、
 *     `gen_ai.request.model` / `gen_ai.response.model`、`gen_ai.usage.input_tokens`（**含缓存命中**）/
 *     `gen_ai.usage.output_tokens`、`gen_ai.usage.cache_read.input_tokens`（是 input_tokens 的子集）、
 *     `gen_ai.response.finish_reasons`、`gen_ai.conversation.id`、`error.type`；
 *     span 名 `{gen_ai.operation.name} {gen_ai.request.model}`，kind=CLIENT。
 *   - execute tool span：`gen_ai.operation.name`=`execute_tool`(Required)、`gen_ai.tool.name`(Required)、
 *     `gen_ai.tool.type`(Recommended, `function`)、`gen_ai.tool.call.id`(Recommended)、
 *     `gen_ai.agent.name`(Conditionally Required)、`error.type`（失败时）；
 *     span 名 `execute_tool {gen_ai.tool.name}`，kind=INTERNAL。
 *   - Opt-In 正文属性：`gen_ai.input.messages` / `gen_ai.output.messages` /
 *     `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result`——**默认一律不采集**（见下）。
 * - OTLP 规范 1.11.0（trace 信号已 Stable，`opentelemetry-specification/specification/protocol/otlp.md`）：
 *   - HTTP 传输：`POST <endpoint>/v1/traces`，`Content-Type: application/json`；
 *     `OTEL_EXPORTER_OTLP_ENDPOINT` 是**基础端点**需补 `/v1/traces`，
 *     `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 是**信号级端点**按原样使用。
 *   - `traceId` / `spanId` 在 OTLP/JSON 中是**十六进制字符串**（16/8 字节 → 32/16 个十六进制字符），
 *     规范明确“不是 Protobuf JSON Mapping 默认的 base64”（另见本文档 base64 说法为常见误记）。
 *   - `startTimeUnixNano` / `endTimeUnixNano` 是 int64 → JSON **字符串**；
 *     属性形状为 `{key, value:{stringValue|intValue|boolValue|doubleValue|arrayValue}}`，
 *     其中 `intValue` 同为 int64 → 字符串；`kind` / `status.code` 用枚举名（SPAN_KIND_* / STATUS_CODE_*）。
 *
 * ## 设计约束
 * - **零第三方依赖**：手写 OTLP/JSON，不引入 `@opentelemetry/*`（命名与属性形状才是 semconv 的要点）。
 * - **默认关闭、零网络**：只有解析到导出端点才注册监听器/起定时器；未配置时不做任何网络访问。
 * - **绝不拖累主链路**：导出失败一律吞掉并计数（告警限流），监听器同步返回、不做 await。
 * - **机密与隐私**：默认不采集 prompt / 回复 / 工具参数与结果正文；显式开启后也必须先经
 *   `redactSecrets` + `maskSecrets` 脱敏，因为这会**把用户内容发往外部 collector**。
 */
import { randomBytes } from 'node:crypto'
import type { Logger, PluginDefinition } from '@zhuxing/harness-kernel'
import { maskSecrets } from '@zhuxing/harness-kernel'
import { redactSecrets } from '@zhuxing/harness-agent'

/** 属性值域（GenAI 约定里用到的标量与字符串数组）。 */
export type GenAiAttributeValue = string | number | boolean | string[]

/** 待导出的 span：属性名已按 GenAI 语义约定命名，时间为 Unix nano。 */
export interface GenAiSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'SPAN_KIND_CLIENT' | 'SPAN_KIND_INTERNAL'
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, GenAiAttributeValue>
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'; message?: string }
}

/** inference（chat）span 输入。 */
export interface InferenceSpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  /** 规范 Required；未显式给出时按 baseUrl 推断。 */
  providerName?: string
  /** 用于推断 provider（如 https://api.deepseek.com/v1 → deepseek）。 */
  baseUrl?: string
  requestModel?: string
  responseModel?: string
  /** 对应本仓 sessionId（规范：无可靠会话标识时不得编造）。 */
  conversationId?: string
  /** 输入 token 总数：规范要求**包含缓存命中**的 token。 */
  inputTokens?: number
  outputTokens?: number
  /** 命中缓存的输入 token（inputTokens 的子集）。 */
  cacheReadInputTokens?: number
  finishReasons?: string[]
  /** 失败时的低基数错误标识；给出即把 span status 置为 ERROR 并写 `error.type`。 */
  errorType?: string
  errorMessage?: string
  serverAddress?: string
  /** Opt-In 正文：只有显式开启采集时才会被调用方传入，且传入前必须已脱敏。 */
  inputMessages?: string
  outputMessages?: string
}

/** execute_tool span 输入。 */
export interface ToolSpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  toolName: string
  /** 工具调用 id（来自 `tools/after-exec` 事件载荷，由 registry 从 ToolExecuteContext 透传）。 */
  callId?: string
  description?: string
  conversationId?: string
  agentName?: string
  /** 失败时的低基数错误标识（如 execution_error / policy_rejected）。 */
  errorType?: string
  errorMessage?: string
  /** Opt-In 正文：只有显式开启采集时才会被调用方传入，且传入前必须已脱敏。 */
  argumentsJson?: string
  resultText?: string
}

/** 本仓使用的 agent 身份（写进 `gen_ai.agent.name` / `gen_ai.agent.id`）。 */
export const AGENT_NAME = 'zhuxing-harness'
export const AGENT_ID = 'harness-agent'

/** provider 名推断：把本仓 baseUrl 映射到 GenAI 约定枚举值。 */
const PROVIDER_HINTS: Array<[RegExp, string]> = [
  [/deepseek/i, 'deepseek'],
  [/openai\.azure\.com|azure/i, 'azure.ai.openai'],
  [/anthropic/i, 'anthropic'],
  [/generativelanguage\.googleapis\.com/i, 'gcp.gemini'],
  [/aiplatform\.googleapis\.com/i, 'gcp.vertex_ai'],
  [/bedrock/i, 'aws.bedrock'],
  [/watsonx/i, 'ibm.watsonx.ai'],
  [/\bx\.ai\b/i, 'x_ai'],
  [/moonshot/i, 'moonshot_ai'],
  [/mistral/i, 'mistral_ai'],
  [/groq/i, 'groq'],
  [/perplexity/i, 'perplexity'],
  [/cohere/i, 'cohere'],
  [/openai/i, 'openai'],
]

/** 按 baseUrl 推断 `gen_ai.provider.name`（推断不出返回 undefined，由调用方决定兜底值）。 */
export function detectProviderName(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  for (const [pattern, name] of PROVIDER_HINTS) if (pattern.test(baseUrl)) return name
  return undefined
}

/** 毫秒时间戳 → Unix nano 字符串（OTLP/JSON 里 int64 一律用字符串）。 */
export function msToUnixNano(ms: number): string {
  return `${Math.floor(ms)}000000`
}

/** 生成 traceId（16 字节）/ spanId（8 字节）的十六进制表示。 */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/** 构造 inference（chat）span。 */
export function buildInferenceSpan(input: InferenceSpanInput): GenAiSpan {
  const model = input.requestModel
  const attributes: Record<string, GenAiAttributeValue> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': input.providerName ?? detectProviderName(input.baseUrl) ?? 'unknown',
  }
  if (model) attributes['gen_ai.request.model'] = model
  if (input.responseModel) attributes['gen_ai.response.model'] = input.responseModel
  if (input.conversationId) attributes['gen_ai.conversation.id'] = input.conversationId
  if (typeof input.inputTokens === 'number') attributes['gen_ai.usage.input_tokens'] = input.inputTokens
  if (typeof input.outputTokens === 'number') attributes['gen_ai.usage.output_tokens'] = input.outputTokens
  if (typeof input.cacheReadInputTokens === 'number') {
    attributes['gen_ai.usage.cache_read.input_tokens'] = input.cacheReadInputTokens
  }
  if (input.finishReasons?.length) attributes['gen_ai.response.finish_reasons'] = [...input.finishReasons]
  if (input.serverAddress) attributes['server.address'] = input.serverAddress
  if (input.inputMessages) attributes['gen_ai.input.messages'] = input.inputMessages
  if (input.outputMessages) attributes['gen_ai.output.messages'] = input.outputMessages
  if (input.errorType) attributes['error.type'] = input.errorType
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    // 规范：span 名 SHOULD 为 `{gen_ai.operation.name} {gen_ai.request.model}`；无模型名时退化为操作名。
    name: model ? `chat ${model}` : 'chat',
    kind: 'SPAN_KIND_CLIENT',
    startTimeUnixNano: input.startTimeUnixNano,
    endTimeUnixNano: input.endTimeUnixNano,
    attributes,
    status: input.errorType
      ? { code: 'STATUS_CODE_ERROR', message: input.errorMessage }
      : { code: 'STATUS_CODE_OK' },
  }
}

/** 构造 execute_tool span。 */
export function buildToolSpan(input: ToolSpanInput): GenAiSpan {
  const attributes: Record<string, GenAiAttributeValue> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': input.toolName,
    'gen_ai.tool.type': 'function',
  }
  if (input.callId) attributes['gen_ai.tool.call.id'] = input.callId
  if (input.description) attributes['gen_ai.tool.description'] = input.description
  if (input.agentName) attributes['gen_ai.agent.name'] = input.agentName
  if (input.conversationId) attributes['gen_ai.conversation.id'] = input.conversationId
  if (input.argumentsJson) attributes['gen_ai.tool.call.arguments'] = input.argumentsJson
  if (input.resultText) attributes['gen_ai.tool.call.result'] = input.resultText
  if (input.errorType) attributes['error.type'] = input.errorType
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: `execute_tool ${input.toolName}`,
    // 本进程内执行工具，按规范用 INTERNAL。
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: input.startTimeUnixNano,
    endTimeUnixNano: input.endTimeUnixNano,
    attributes,
    status: input.errorType
      ? { code: 'STATUS_CODE_ERROR', message: input.errorMessage }
      : { code: 'STATUS_CODE_OK' },
  }
}

/** 单个属性 → OTLP/JSON 值对象（int64 一律用字符串，数组用 `arrayValue`）。 */
export function toOtlpAttributeValue(value: GenAiAttributeValue): Record<string, unknown> {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } }
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (Number.isInteger(value)) return { intValue: String(value) }
  return { doubleValue: value }
}

/** 属性表 → OTLP/JSON `KeyValue[]`。 */
export function toOtlpAttributes(attributes: Record<string, GenAiAttributeValue>): Array<{ key: string; value: unknown }> {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toOtlpAttributeValue(value) }))
}

/** instrumentation scope 名（标识 span 由本仓产生）。 */
export const TELEMETRY_SCOPE_NAME = 'zhuxing-harness/genai'

/** resource 描述。 */
export interface OtlpResource {
  serviceName: string
  extraAttributes?: Record<string, string>
}

/** 构造 OTLP/JSON 的 `ExportTraceServiceRequest`（`resourceSpans[].scopeSpans[].spans[]`）。 */
export function buildOtlpTracesRequest(spans: GenAiSpan[], resource: OtlpResource): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toOtlpAttributes({
            'service.name': resource.serviceName,
            ...(resource.extraAttributes ?? {}),
          }),
        },
        scopeSpans: [
          {
            scope: { name: TELEMETRY_SCOPE_NAME },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: toOtlpAttributes(span.attributes),
              status: span.status,
            })),
          },
        ],
      },
    ],
  }
}

/** 解析结果：导出端点与相关开关。 */
export interface TelemetryConfig {
  /** 完整的 traces 端点（已含 /v1/traces）。 */
  endpoint: string
  headers: Record<string, string>
  serviceName: string
  captureContent: boolean
}

/** `key=value,key2=value2` → 头对象（值按 OTLP 约定做 URL 解码）。 */
export function parseOtlpHeaders(raw?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!raw) return headers
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!key) continue
    try {
      headers[key] = decodeURIComponent(value)
    } catch {
      headers[key] = value
    }
  }
  return headers
}

/**
 * 解析导出配置。优先级（沿用生态惯例）：
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（信号级，按原样使用）
 * > `OTEL_EXPORTER_OTLP_ENDPOINT`（基础端点，补 `/v1/traces`）
 * > 显式传入的端点（同样按基础端点处理）。
 * 三处都没有 → 返回 undefined（遥测保持关闭，不做任何网络访问）。
 */
export function resolveTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  explicitEndpoint?: string,
): TelemetryConfig | undefined {
  const signalEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  const fallbackEndpoint = explicitEndpoint?.trim()
  let endpoint: string | undefined
  if (signalEndpoint) endpoint = signalEndpoint
  else if (baseEndpoint) endpoint = `${baseEndpoint.replace(/\/+$/, '')}/v1/traces`
  else if (fallbackEndpoint) endpoint = `${fallbackEndpoint.replace(/\/+$/, '')}/v1/traces`
  if (!endpoint) return undefined
  return {
    endpoint,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || 'zhuxing-harness',
    // 正文采集默认关闭：开启即把用户内容发往外部 collector，属显式选择。
    captureContent: /^(1|true|yes)$/i.test(env.OTEL_GENAI_CAPTURE_CONTENT?.trim() ?? ''),
  }
}

/** 有界 span 缓冲：溢出丢最旧的 span 并计数（避免 collector 不可达时无界增长）。 */
export class SpanBuffer {
  private items: GenAiSpan[] = []
  private droppedCount = 0

  constructor(private readonly limit: number) {}

  /** 入队；返回是否成功保留（溢出时为 false，但计数已累加）。 */
  add(span: GenAiSpan): boolean {
    if (this.limit <= 0) {
      this.droppedCount += 1
      return false
    }
    if (this.items.length >= this.limit) {
      this.items.shift()
      this.droppedCount += 1
      this.items.push(span)
      return false
    }
    this.items.push(span)
    return true
  }

  /** 取出并清空（导出失败不回收：不重试堆积，只计数）。 */
  drain(): GenAiSpan[] {
    const out = this.items
    this.items = []
    return out
  }

  get size(): number {
    return this.items.length
  }

  get dropped(): number {
    return this.droppedCount
  }
}

/** 导出计数（供自省/测试观测）。 */
export interface TelemetryStats {
  /** 被 collector 接受的 span 数。 */
  exported: number
  /** 导出失败的 span 数。 */
  failed: number
  /** 因缓冲溢出被丢弃的 span 数。 */
  dropped: number
  /** 当前待导出 span 数。 */
  pending: number
}

export interface OtlpExporterOptions {
  endpoint: string
  serviceName: string
  headers?: Record<string, string>
  bufferLimit?: number
  timeoutMs?: number
  logger?: Logger
  fetchImpl?: typeof fetch
}

/** 失败告警间隔：collector 不可达时不要每个 span 刷屏。 */
const WARN_INTERVAL_MS = 30_000

/** OTLP/JSON 导出器：批量发送、失败吞掉并计数、绝不抛出（不得拖累主链路）。 */
export class OtlpSpanExporter {
  private buffer: SpanBuffer
  private exported = 0
  private failed = 0
  private failEvents = 0
  private lastWarnAt = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: OtlpExporterOptions) {
    this.buffer = new SpanBuffer(opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT)
  }

  add(span: GenAiSpan): boolean {
    return this.buffer.add(span)
  }

  stats(): TelemetryStats {
    return {
      exported: this.exported,
      failed: this.failed,
      dropped: this.buffer.dropped,
      pending: this.buffer.size,
    }
  }

  /** 批量导出当前缓冲；始终 resolve（失败已计数并限流告警）。 */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.exportBatch()).catch(() => undefined)
    return this.chain
  }

  private async exportBatch(): Promise<void> {
    const spans = this.buffer.drain()
    if (spans.length === 0) return
    const body = JSON.stringify(buildOtlpTracesRequest(spans, { serviceName: this.opts.serviceName }))
    try {
      const doFetch = this.opts.fetchImpl ?? fetch
      const res = await doFetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`collector 返回 HTTP ${res.status}`)
      // 读掉响应体，避免连接悬挂；读失败不影响已成功的判定。
      await res.text().catch(() => '')
      this.exported += spans.length
    } catch (err) {
      this.failed += spans.length
      this.failEvents += 1
      const now = Date.now()
      if (this.failEvents === 1 || now - this.lastWarnAt >= WARN_INTERVAL_MS) {
        this.lastWarnAt = now
        const message = err instanceof Error ? err.message : String(err)
        this.opts.logger?.warn(
          `[telemetry] OTLP 导出失败（已丢弃 ${this.failed} 个 span，累计 ${this.failEvents} 次），不影响主流程：${message}`,
        )
      }
    }
  }
}

/** 默认批量导出间隔（ms）。 */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000
/** 默认缓冲上限（span 数）。 */
export const DEFAULT_BUFFER_LIMIT = 2_048
/** 默认单次导出超时（ms）。 */
export const DEFAULT_EXPORT_TIMEOUT_MS = 5_000

export interface TelemetryPluginDeps {
  /** resource 上的 `service.name`（缺省取 `OTEL_SERVICE_NAME` 或 `zhuxing-harness`）。 */
  serviceName?: string
  /** 显式端点（最低优先级，仅当两个 OTEL 环境变量都未设置时使用）。 */
  endpoint?: string
  /**
   * 模型端点基础地址（如 https://api.deepseek.com/v1）：
   * 用于推断 GenAI 约定 Required 的 `gen_ai.provider.name`（推断不出时写 `unknown`）。
   */
  baseUrl?: string
  /** 环境变量视图（测试注入；缺省 process.env）。 */
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  bufferLimit?: number
  flushIntervalMs?: number
  timeoutMs?: number
  /** 采集正文（prompt / 回复 / 工具参数与结果）：默认关闭，开启前请确认接受「用户内容发往 collector」。 */
  captureContent?: boolean
}

/** 工具执行前事件载荷（见 packages/tools/src/registry.ts）。 */
interface BeforeExecPayload {
  name?: string
  args?: Record<string, unknown>
  /** 会话与调用关联字段（registry 从 ToolExecuteContext 透传）。 */
  sessionId?: string
  callId?: string
}

/** 工具执行后事件载荷。 */
interface AfterExecPayload {
  name?: string
  result?: { error?: string; text?: string; json?: unknown }
  error?: boolean
  rejectedBy?: string
  unknownTool?: boolean
  /** 会话与调用关联字段（registry 从 ToolExecuteContext 透传）。 */
  sessionId?: string
  callId?: string
  /** registry（唯一执行点）实测的执行耗时（ms）。 */
  durationMs?: number
  /** registry 的显式成败判定。 */
  ok?: boolean
}

/** LLM 调用前事件载荷（见 packages/agent 的 LlmRequestEvent）。 */
interface LlmRequestPayload {
  sessionId?: string
  step?: number
  model?: string
}

/** LLM 调用成功事件载荷（LlmResponseEvent）。 */
interface LlmResponsePayload extends LlmRequestPayload {
  responseModel?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cacheHitTokens?: number
    cacheMissTokens?: number
  }
  finishReasons?: unknown
  latencyMs?: number
}

/** LLM 调用失败事件载荷（LlmErrorEvent）。 */
interface LlmErrorPayload extends LlmRequestPayload {
  errorType?: string
  message?: string
  latencyMs?: number
}

/** 非空字符串读取。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 有限数字读取（NaN / Infinity / 非数字一律不采纳，避免写进 span 属性）。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 字符串数组读取（空数组视为缺失）。 */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return out.length > 0 ? out : undefined
}

/** 正文脱敏：先按 DLP 规则替换凭据，再做掩码（正文属性是默认关闭的可选项）。 */
function sanitizeContent(text: string): string {
  return maskSecrets(redactSecrets(text))
}

/** 工具结果 → 单行文本（仅用于 Opt-In 的 `gen_ai.tool.call.result`）。 */
function toolResultText(result: AfterExecPayload['result']): string | undefined {
  if (!result) return undefined
  if (result.error !== undefined) return `error: ${result.error}`
  if (typeof result.text === 'string') return result.text
  if (result.json !== undefined) return JSON.stringify(result.json)
  return undefined
}

/** 工具参数 → 单行 JSON（仅用于 Opt-In 的 `gen_ai.tool.call.arguments`）。 */
function stringifyArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  try {
    return sanitizeContent(JSON.stringify(args))
  } catch {
    // 参数无法序列化时放弃该 Opt-In 属性，绝不因遥测抛错。
    return undefined
  }
}

/** 工具失败的 error.type：按规范用低基数分类值。 */
function toolErrorType(payload: AfterExecPayload): string | undefined {
  if (payload.unknownTool) return 'unknown_tool'
  if (payload.rejectedBy === 'policy') return 'policy_rejected'
  if (payload.rejectedBy === 'sandbox') return 'sandbox_rejected'
  if (payload.error === true || payload.result?.error !== undefined) return 'tool_execution_error'
  return undefined
}

/** 已开始但尚未结束的工具调用（用于配对起止并计算耗时）。 */
interface PendingTool {
  startedAtMs: number
  traceId: string
  conversationId?: string
  /** Opt-In 参数正文（before-exec 携带 args，after-exec 只有结果）。 */
  argumentsJson?: string
}

/** 已开始但尚未结束的模型调用（按 `sessionId#step` 配对，并发会话互不干扰）。 */
interface PendingChat {
  startedAtMs: number
  traceId: string
  sessionId: string
  model?: string
}

/**
 * 遥测插件：订阅内核事件 → 生成 GenAI span → 按间隔批量 OTLP/JSON 导出，插件卸载时 flush。
 *
 * span 来源：
 * - `agent/llm-request` + `agent/llm-response`/`agent/llm-error` → inference（chat）span（含 token 用量与失败分类）；
 * - `tools/before-exec` + `tools/after-exec` → execute_tool span（含真实 sessionId / callId 关联）。
 *
 * 注：`invoke_agent` span 暂未产出——现有 `agent/pre-step` / `agent/post-step` 是**按 step** 派发的，
 * 且 rejected / llm-error / max-steps / aborted 等终止路径没有对应的收尾事件（verifyFailed 的收尾事件
 * 与「继续循环」的载荷完全相同），据此配对会产出语义错误的 span，故不做（详见交付说明）。
 */
export function telemetryPlugins(deps: TelemetryPluginDeps = {}): PluginDefinition[] {
  return [
    {
      name: 'harness-telemetry',
      description: 'OpenTelemetry GenAI 语义约定 trace 导出（OTLP/JSON over HTTP；默认关闭；零第三方依赖）',
      apply(ctx) {
        const env = deps.env ?? process.env
        const config = resolveTelemetryConfig(env, deps.endpoint)
        if (!config) {
          // 默认关闭：不注册监听器、不起定时器、不发起任何网络请求。
          ctx.logger.debug(
            '[telemetry] 未配置 OTLP 端点（OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT），遥测保持关闭。',
          )
          return
        }
        const captureContent = deps.captureContent ?? config.captureContent
        const exporter = new OtlpSpanExporter({
          endpoint: config.endpoint,
          serviceName: deps.serviceName ?? config.serviceName,
          headers: config.headers,
          bufferLimit: deps.bufferLimit,
          timeoutMs: deps.timeoutMs,
          logger: ctx.logger,
          fetchImpl: deps.fetchImpl,
        })

        // 会话/调用关联：tools/* 与 agent/llm-* 事件都携带真实 sessionId（AgentLoop / registry 透传），
        // 不再依赖「最近一次 agent/pre-step」的 best-effort 关联——那正是多会话并发串号的来源。
        // 工具调用按 callId 配对起止（唯一）；缺失 callId 的发射方退回按工具名配对。
        const pendingTools = new Map<string, PendingTool[]>()
        // 模型调用按 `sessionId#step` 配对（并发会话各持自己的键，互不干扰）。
        const pendingChats = new Map<string, PendingChat>()

        /** 取出并删除配对的待结束模型调用。 */
        const takePendingChat = (payload: LlmRequestPayload | undefined): PendingChat | undefined => {
          const sessionId = nonEmptyString(payload?.sessionId)
          if (sessionId === undefined || typeof payload?.step !== 'number') return undefined
          const key = `${sessionId}#${payload.step}`
          const pending = pendingChats.get(key)
          if (pending) pendingChats.delete(key)
          return pending
        }

        /** 起止时间：有配对起点用起点；否则用事件自带的 latencyMs 回推；都没有则退化为瞬时 span。 */
        const spanRange = (startedAtMs: number | undefined, latencyMs: number | undefined, endMs: number): [number, number] => {
          if (startedAtMs !== undefined) return [startedAtMs, endMs]
          if (latencyMs !== undefined && latencyMs >= 0) return [endMs - latencyMs, endMs]
          return [endMs, endMs]
        }

        ctx.on<LlmRequestPayload>('agent/llm-request', (payload) => {
          const sessionId = nonEmptyString(payload?.sessionId)
          if (sessionId === undefined || typeof payload?.step !== 'number') return
          pendingChats.set(`${sessionId}#${payload.step}`, {
            startedAtMs: Date.now(),
            traceId: randomHex(16),
            sessionId,
            model: nonEmptyString(payload?.model),
          })
        })

        ctx.on<LlmResponsePayload>('agent/llm-response', (payload) => {
          const pending = takePendingChat(payload)
          const endMs = Date.now()
          const [startMs, end] = spanRange(pending?.startedAtMs, finiteNumber(payload?.latencyMs), endMs)
          const usage = payload?.usage
          exporter.add(
            buildInferenceSpan({
              traceId: pending?.traceId ?? randomHex(16),
              spanId: randomHex(8),
              startTimeUnixNano: msToUnixNano(startMs),
              endTimeUnixNano: msToUnixNano(end),
              // Required 的 provider.name：按 baseUrl 推断，推断不出时 buildInferenceSpan 兜底 'unknown'。
              baseUrl: deps.baseUrl,
              requestModel: pending?.model ?? nonEmptyString(payload?.model),
              responseModel: nonEmptyString(payload?.responseModel),
              conversationId: pending?.sessionId ?? nonEmptyString(payload?.sessionId),
              // 规范要求 input_tokens 含缓存命中；provider（OpenAI 兼容）的 promptTokens 即含缓存的总量。
              inputTokens: finiteNumber(usage?.promptTokens),
              outputTokens: finiteNumber(usage?.completionTokens),
              cacheReadInputTokens: finiteNumber(usage?.cacheHitTokens),
              finishReasons: stringList(payload?.finishReasons),
            }),
          )
        })

        ctx.on<LlmErrorPayload>('agent/llm-error', (payload) => {
          const pending = takePendingChat(payload)
          const endMs = Date.now()
          const [startMs, end] = spanRange(pending?.startedAtMs, finiteNumber(payload?.latencyMs), endMs)
          exporter.add(
            buildInferenceSpan({
              traceId: pending?.traceId ?? randomHex(16),
              spanId: randomHex(8),
              startTimeUnixNano: msToUnixNano(startMs),
              endTimeUnixNano: msToUnixNano(end),
              baseUrl: deps.baseUrl,
              requestModel: pending?.model ?? nonEmptyString(payload?.model),
              conversationId: pending?.sessionId ?? nonEmptyString(payload?.sessionId),
              // error.type 是低基数枚举：失败事件本身即失败，缺失分类时退化为通用 'llm_error'。
              errorType: nonEmptyString(payload?.errorType) ?? 'llm_error',
              errorMessage: nonEmptyString(payload?.message),
            }),
          )
        })

        ctx.on<BeforeExecPayload>('tools/before-exec', (payload) => {
          const name = payload?.name
          if (typeof name !== 'string') return
          const key = nonEmptyString(payload?.callId) ?? name
          const queue = pendingTools.get(key) ?? []
          queue.push({
            startedAtMs: Date.now(),
            traceId: randomHex(16),
            conversationId: nonEmptyString(payload?.sessionId),
            argumentsJson: captureContent ? stringifyArgs(payload?.args) : undefined,
          })
          pendingTools.set(key, queue)
        })

        ctx.on<AfterExecPayload>('tools/after-exec', (payload) => {
          const name = payload?.name
          if (typeof name !== 'string') return
          const callId = nonEmptyString(payload?.callId)
          const key = callId ?? name
          const queue = pendingTools.get(key)
          const started = queue?.shift()
          if (queue && queue.length === 0) pendingTools.delete(key)
          const endMs = Date.now()
          // 优先用 registry 实测耗时回推起始时刻：未知工具等没有 before-exec 的路径也能得到真实时长。
          const reported = finiteNumber(payload?.durationMs)
          const startMs = started?.startedAtMs ?? (reported !== undefined && reported >= 0 ? endMs - reported : endMs)
          const resultText = captureContent ? toolResultText(payload?.result) : undefined
          exporter.add(
            buildToolSpan({
              traceId: started?.traceId ?? randomHex(16),
              spanId: randomHex(8),
              startTimeUnixNano: msToUnixNano(startMs),
              endTimeUnixNano: msToUnixNano(endMs),
              toolName: name,
              callId,
              conversationId: nonEmptyString(payload?.sessionId) ?? started?.conversationId,
              agentName: AGENT_NAME,
              errorType: toolErrorType(payload),
              errorMessage: payload?.result?.error,
              argumentsJson: started?.argumentsJson,
              resultText: resultText ? sanitizeContent(resultText) : undefined,
            }),
          )
        })

        const timer = setInterval(() => void exporter.flush(), deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
        // 不阻塞进程退出：待导出 span 由卸载时的 flush 送出。
        timer.unref?.()

        ctx.provide('telemetry', {
          enabled: true,
          endpoint: config.endpoint,
          captureContent,
          stats: () => exporter.stats(),
          flush: () => exporter.flush(),
        })

        ctx.effect(async () => {
          clearInterval(timer)
          pendingTools.clear()
          await exporter.flush()
        })
      },
    },
  ]
}
