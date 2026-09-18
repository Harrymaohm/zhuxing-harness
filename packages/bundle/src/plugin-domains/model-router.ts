/** 模型路由插件：模型注册表（热插拔）+ 实时监控 + 选择算法 + 统一交互接口 + 模型间通信协议。 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { ChatProvider } from '@zhuxing/harness-llm'
import {
  ModelMonitorImpl,
  ModelOrchestratorImpl,
  ModelRegistryImpl,
  ModelRouterImpl,
  ModelSelectorImpl,
} from '@zhuxing/harness-model-router'
import type { ModelCapability, ModelMetrics, ModelOrchestrator } from '@zhuxing/harness-model-router'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'
import { DEFAULT_TOKEN_PLAN_ORIGIN, tokenPlanChatBase } from '../token-plan.js'

export function modelRouterPlugins(
  deps: Pick<BaseBundleOptions, 'apiKey' | 'baseUrl' | 'model' | 'models' | 'router' | 'tokenPlan'>,
): PluginDefinition[] {
  return [
    {
      name: 'harness-model-router',
      description: '多子模型路由与编排：模型注册表（热插拔）、实时监控、选择算法、统一交互接口、模型间通信协议',
      inject: ['llm', 'tools'],
      apply(ctx) {
        const mainLlm = ctx.inject<ChatProvider>('llm')
        const tools = ctx.inject<ToolRegistry>('tools')
        const baseUrl = deps.baseUrl ?? 'https://api.deepseek.com/v1'

        const registry = new ModelRegistryImpl()
        const monitor = new ModelMonitorImpl()
        const selector = new ModelSelectorImpl(registry, monitor, deps.router?.selector)
        const router = new ModelRouterImpl(registry, monitor, selector, { fallback: deps.router?.fallback })
        const orchestrator: ModelOrchestrator = new ModelOrchestratorImpl(registry, monitor, router)

        // 1. 注册主编排模型（默认模型 id 为 'default'，对应主 llm）
        registry.register(
          { id: 'default', label: deps.model, capabilities: ['general'], contextWindow: deps.models?.find((m) => m.id === 'default')?.contextWindow },
          mainLlm,
        )
        // 2. 注册子模型（config.models）
        const disposers: Array<() => void> = []
        for (const entry of deps.models ?? []) {
          if (entry.id === 'default') continue // 主模型已在上面注册
          if (registry.has(entry.id)) continue // 与已注册模型（含下方 token-plan 文本模型）id 重复时跳过，避免重复注册报错使整个服务崩溃
          const provider = new OpenAICompatibleProvider({
            apiKey: entry.apiKey ?? deps.apiKey,
            baseUrl: entry.baseUrl ?? baseUrl,
            model: entry.model,
            timeoutMs: entry.timeoutMs,
          })
          disposers.push(
            registry.register(
              { id: entry.id, label: entry.label ?? entry.id, capabilities: entry.capabilities, contextWindow: entry.contextWindow, costPer1k: entry.costPer1k },
              provider,
            ),
          )
        }
        // 2.5 注册 token-plan 文本子模型（单独配置的阿里云聚合 API，走兼容模式文本端点）
        const tokenPlan = deps.tokenPlan
        if (tokenPlan) {
          const tpChatBase = tokenPlanChatBase(tokenPlan.baseUrl ?? DEFAULT_TOKEN_PLAN_ORIGIN)
          const tpApiKey = tokenPlan.apiKey ?? deps.apiKey
          for (const entry of tokenPlan.textModels ?? []) {
            if (entry.id === 'default') continue // 主模型已在上面注册
            if (registry.has(entry.id)) continue // config.models 已注册同 id → 跳过，避免重复注册报错使整个服务崩溃
            const provider = new OpenAICompatibleProvider({
              apiKey: entry.apiKey ?? tpApiKey,
              baseUrl: entry.baseUrl ?? tpChatBase,
              model: entry.model,
              timeoutMs: entry.timeoutMs,
            })
            disposers.push(
              registry.register(
                { id: entry.id, label: entry.label ?? entry.id, capabilities: entry.capabilities, contextWindow: entry.contextWindow, costPer1k: entry.costPer1k },
                provider,
              ),
            )
          }
        }

        // 3. 提供服务（统一交互接口 / 监控 / 选择 / 编排）
        ctx.provide('modelRegistry', registry)
        ctx.provide('modelMonitor', monitor)
        ctx.provide('modelSelector', selector)
        ctx.provide('modelRouter', router)
        ctx.provide('orchestrator', orchestrator)

        // 4. 模型间通信协议工具：编排模型动态选择子模型
        const unregisterPick = tools.register({
          name: 'pick_model',
          description:
            '动态选择一个子模型执行子任务并返回统一格式结果（由主编排模型调用）。' +
            '根据任务需求、上下文长度与实时性能指标自动选择子模型（不会选到主模型自身）；可显式指定 modelId。' +
            '适合专项子任务（代码/推理/文案/长文档）与可并行的独立子任务；简单问题请自行回答。' +
            '未配置子模型时返回 ok=false 与配置指引。' +
            '返回 { ok, modelId, content, usage, latencyMs, estCost, error? }。' +
            '若返回 ok=false（或 error 非空），说明委派未成功：不要对同一任务原样重复委派，改为自行完成或换 modelId/换任务描述。',
          schema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: '子任务描述（将作为子模型输入）' },
              context: { type: 'string', description: '附加上下文（可省略）' },
              modelId: { type: 'string', description: '可选：显式指定子模型 id（否则自动选择）' },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：能力偏好（如 code / reasoning / fast）',
              },
              maxTokens: { type: 'integer', description: '可选：子模型最大输出 token' },
              temperature: { type: 'number', description: '可选：采样温度' },
            },
            required: ['task'],
          },
          // 子模型是真实 LLM 调用（供应商默认超时 120s），需高于工具默认 60s，否则必然被截断。
          timeoutMs: 180_000,
          execute: async (args) => {
            const result = await orchestrator.delegate({
              task: String(args.task ?? ''),
              context: args.context ? String(args.context) : undefined,
              hints: {
                modelId: args.modelId ? String(args.modelId) : undefined,
                capabilities: Array.isArray(args.capabilities) ? (args.capabilities as ModelCapability[]) : undefined,
                maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
                temperature: typeof args.temperature === 'number' ? args.temperature : undefined,
              },
            })
            return { json: result }
          },
        })

        // 5. 模型发现工具：编排模型查看可用子模型与实时指标
        const unregisterList = tools.register({
          name: 'list_models',
          description:
            '列出当前可用子模型及其能力标签与实时性能指标（成功率 / 平均延迟 / 调用次数 / 成本 / 前缀缓存命中率），供主编排模型决策是否用 pick_model 委派。返回 JSON 数组。' +
            '注意：本进程尚未发生任何模型调用时，metrics.sampled=false 且数值字段为 null（note 为「暂无采样」）——' +
            '这表示「还没有采样」，不是「性能为 0」，不要据此断定某模型不可用或监控失效。',
          schema: { type: 'object', properties: {}, required: [] },
          execute: async () => ({
            json: orchestrator.listModels().map((m) => ({ ...m, metrics: toMetricsView(m.metrics) })),
          }),
        })

        // 6. 热插拔：插件卸载时注销全部子模型与工具
        ctx.effect(() => {
          for (const dispose of disposers) dispose()
          unregisterPick()
          unregisterList()
        })
      },
    },
  ]
}

/** 无采样时的统一文案。 */
export const NO_SAMPLE_NOTE = '暂无采样'

/**
 * 指标展示视图：区分「尚无采样」与「真实为 0」。
 *
 * 本进程一次模型调用都没发生时 `calls === 0`，此时数值型指标一律为 null 并带 note，
 * 由展示层渲染成「暂无采样」/「—」，**不得**渲染成 0 / 0% / 100%
 * （monitor 在无数据时返回 `successRate: 1`，直接展示会被读成「成功率 100%」或「监控没在采集」）。
 * `calls` 自身保持真实数字：0 次调用是事实，不是缺失。
 */
export interface ModelMetricsView {
  /** 是否有采样数据（false = 本进程尚未发生模型调用）。 */
  sampled: boolean
  /** 无采样时的说明；有采样时为 undefined。 */
  note?: string
  calls: number
  ok: number | null
  fail: number | null
  /** 成功率百分比（0-100，已取整）；无采样为 null。 */
  successRatePct: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  totalTokens: number | null
  estCost: number | null
  /** 前缀缓存命中率百分比（0-100，已取整）；无采样为 null。 */
  cacheHitRatePct: number | null
  lastError?: string
}

/** `ModelMetrics` → 展示视图（无采样时数值字段置 null）。 */
export function toMetricsView(metrics: ModelMetrics): ModelMetricsView {
  if (metrics.calls === 0) {
    return {
      sampled: false,
      note: NO_SAMPLE_NOTE,
      calls: 0,
      ok: null,
      fail: null,
      successRatePct: null,
      avgLatencyMs: null,
      p95LatencyMs: null,
      totalTokens: null,
      estCost: null,
      cacheHitRatePct: null,
    }
  }
  return {
    sampled: true,
    calls: metrics.calls,
    ok: metrics.ok,
    fail: metrics.fail,
    successRatePct: Math.round(metrics.successRate * 100),
    avgLatencyMs: metrics.avgLatencyMs,
    p95LatencyMs: metrics.p95LatencyMs,
    totalTokens: metrics.totalTokens,
    estCost: metrics.estCost,
    cacheHitRatePct: Math.round(metrics.cacheHitRate * 100),
    lastError: metrics.lastError,
  }
}

/** 指标单行文案（`harness models list|stats` 共用，单一事实来源）。 */
export function formatModelMetricsLine(metrics: ModelMetrics): string {
  const view = toMetricsView(metrics)
  if (!view.sampled) return `${NO_SAMPLE_NOTE}（本进程尚未发生模型调用）`
  return (
    `成功率 ${view.successRatePct}% · 平均延迟 ${view.avgLatencyMs}ms · 调用 ${view.calls} 次 · ` +
    `token ${view.totalTokens} · 成本估算 ¥${view.estCost} · 缓存命中 ${view.cacheHitRatePct}%`
  )
}
