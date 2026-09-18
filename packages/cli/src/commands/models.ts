import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createHarness } from '@zhuxing/harness-kernel'
import type { ModelConfigEntry, ModelOrchestrator } from '@zhuxing/harness-model-router'
import { parseModelsConfig } from '@zhuxing/harness-model-router'
import { baseBundlePlugins, formatModelMetricsLine } from '@zhuxing/harness-bundle'
import type { TokenPlanOptions } from '@zhuxing/harness-bundle'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { loadConfig, loadDotEnv } from '../config-store.js'
import type { HarnessConfig } from '../config-store.js'
import { out, outError } from '../output.js'

/** 多子模型管理：list（列表）/ stats（实时性能指标）。 */
export async function cmdModels(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { models: { type: 'string' } },
    allowPositionals: true,
  })
  const sub = positionals[0]
  const cwd = process.cwd()
  loadDotEnv(cwd)
  const cfg = loadConfig()
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? cfg.apiKey
  const models = values.models
    ? (JSON.parse(values.models) as ModelConfigEntry[])
    : parseModelsConfig(cfg)

  const app = createHarness({ logLevel: 'warn' })
  try {
    for (const def of baseBundlePlugins({
      apiKey: apiKey ?? '',
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model ?? 'deepseek-v4-flash',
      workspace: resolve(cfg.workspace ?? cwd),
      level: (cfg.level ?? DEFAULT_PERMISSION_LEVEL) as PermissionLevel,
      models,
      tokenPlan: parseTokenPlanConfig(cfg),
    })) {
      await app.mount(def)
    }
    const orchestrator = app.pluginManager.get('harness-model-router')?.ctx.inject<ModelOrchestrator>('orchestrator')
    if (!orchestrator) {
      outError('模型路由未就绪')
      process.exitCode = 1
      return
    }
    const list = orchestrator.listModels()
    // 指标展示统一走 formatModelMetricsLine：无采样（本进程一次模型调用都没发生）显示「暂无采样」，
    // 绝不把「尚无采样」渲染成 0% / 100% / 0ms（那会被读成性能数据或监控失效）。
    if (sub === 'stats') {
      out('子模型实时性能指标：')
      for (const m of list) {
        out(`  ${m.id.padEnd(12)} ${formatModelMetricsLine(m.metrics)}`)
      }
      return
    }
    // 默认 list
    out(`已注册子模型（${list.length} 个）：`)
    for (const m of list) {
      out(
        `  ${m.id.padEnd(12)} ${m.label} · 能力 [${m.capabilities.join(', ')}]${m.contextWindow ? ` · 窗口 ${m.contextWindow}` : ''} · ${formatModelMetricsLine(m.metrics)}`,
      )
    }
    if (list.length <= 1) {
      out('\n提示：仅主模型。可通过 config.models（harness config set models <json>）或 --models 添加子模型。')
    }
  } finally {
    await app.dispose()
  }
}

/**
 * 解析 config.models。实现见 model-router 的 `parseModelsConfig`（全仓唯一一份）；
 * 这里转出同名函数，本包其它命令模块继续从 './models.js' 取用。
 */
export { parseModelsConfig }

/** 解析 config.imageModel（生图模型配置）。 */
export function parseImageModelConfig(cfg: HarnessConfig): { model: string; baseUrl?: string; apiKey?: string; size?: string; mode?: 'openai' | 'dashscope' } | undefined {
  const raw = cfg.imageModel
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as { model?: string; baseUrl?: string; apiKey?: string; size?: string; mode?: 'openai' | 'dashscope' }
  if (!m.model) return undefined
  // 未显式指定 mode 时，若 baseUrl 指向 token-plan / dashscope 网关，默认走多模态生图（token-plan 生图仅支持 multimodal-generation）
  let mode = m.mode
  if (!mode) {
    const bUrl = m.baseUrl ?? ''
    if (/token-plan|aliyuncs|dashscope/i.test(bUrl)) mode = 'dashscope'
  }
  return { model: m.model, baseUrl: m.baseUrl, apiKey: m.apiKey, size: m.size, mode }
}

/** 解析 config.tokenPlan（token-plan 专用 API 下挂多模型）。 */
export function parseTokenPlanConfig(cfg: HarnessConfig): TokenPlanOptions | undefined {
  const raw = cfg.tokenPlan
  if (!raw || typeof raw !== 'object') return undefined
  return raw as TokenPlanOptions
}
