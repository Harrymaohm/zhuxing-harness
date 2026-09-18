import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../http.js'
import { loadWebConfig, parseWebModels } from '../config-store.js'
import type { RouteContext } from './context.js'

/** token-plan 文本生成模型（上游 /compatible-mode/v1/models 读取失败时的内置回退清单，与官方文档对齐）。 */
const TOKEN_PLAN_TEXT_BUILTIN: Array<{ id: string; model: string; label?: string; capabilities?: string[] }> = [
  { id: 'qwen3.8-max', model: 'qwen3.8-max', label: 'Qwen3.8 Max', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'qwen3.7-max', model: 'qwen3.7-max', label: 'Qwen3.7 Max', capabilities: ['reasoning', 'general'] },
  { id: 'qwen3.7-plus', model: 'qwen3.7-plus', label: 'Qwen3.7 Plus', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'qwen3.6-flash', model: 'qwen3.6-flash', label: 'Qwen3.6 Flash', capabilities: ['reasoning', 'vision', 'general'] },
  { id: 'glm-5.2', model: 'glm-5.2', label: 'GLM-5.2', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-pro', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-pro-0813', model: 'deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro 0813', capabilities: ['reasoning', 'general'] },
  { id: 'deepseek-v4-flash-0731', model: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', capabilities: ['general'] },
]

/** token-plan 多模态模型清单（无上游列表接口，按官方文档静态维护）。 */
const TOKEN_PLAN_BUILTIN = {
  imageModels: [{ model: 'qwen-image-2.0' }, { model: 'qwen-image-2.0-pro' }, { model: 'qwen-image-3.0-pro' }, { model: 'wan2.7-image' }, { model: 'wan2.7-image-pro' }],
  videoModels: [
    { model: 'happyhorse-1.1-t2v', label: '文生视频' },
    { model: 'happyhorse-1.1-i2v', label: '图生视频' },
    { model: 'happyhorse-1.1-r2v', label: '视频重绘' },
  ],
  voiceModels: [{ model: 'qwen-audio-3.0-tts-plus', label: '语音合成' }],
  realtimeModels: [{ model: 'qwen-audio-3.0-realtime-plus', label: '实时语音对话' }],
}

/** 从模型名启发式推断能力标签（上游 /models 只给 id，无 capabilities）。 */
function inferTextCaps(model: string): string[] {
  const caps = new Set<string>(['general'])
  const name = model.toLowerCase()
  if (name.includes('qwen') || name.includes('glm') || name.includes('reason') || name.includes('-r1')) caps.add('reasoning')
  if (name.includes('image') || name.includes('vision')) caps.add('vision')
  return [...caps]
}

/** 请求 token-plan 兼容路径的 /models（OpenAI 兼容结构），返回文本生成模型列表。 */
async function fetchTokenPlanTextModels(
  baseUrl: string,
  apiKey: string,
): Promise<Array<{ id: string; model: string; label?: string }>> {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    origin = baseUrl.replace(/\/+$/, '')
  }
  const url = `${origin}/compatible-mode/v1/models`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`上游模型列表获取失败（HTTP ${res.status}）`)
  const payload = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> }
  const list = payload.data ?? payload.models ?? []
  return list
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id as string, model: m.id as string, label: m.name ?? m.id }))
}

/**
 * token-plan 模型清单。
 *
 * 注意：本文件导出两个入口，是因为两者在原 handleRequest 的判定链里**并不相邻**
 * （token-plan 清单在最前段、/api/models 在会话/空间之后）。保持两次调用点即可保持原判定顺序。
 */
export async function handleTokenPlanModelsRoute(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  // 从上游读取 token-plan 模型清单：文本模型走 OpenAI 兼容 /models，多模态模型用官方内置清单
  if (req.method === 'GET' && path === '/api/token-plan/models') {
    const cfg = loadWebConfig()
    const tp = cfg.tokenPlan
    if (!tp?.apiKey) {
      json(res, 400, { error: '未配置 token-plan API Key' })
      return true
    }
    const baseUrl = tp.baseUrl ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com'
    try {
      const textModels = await fetchTokenPlanTextModels(baseUrl, tp.apiKey)
      json(res, 200, {
        textModels: textModels.map((m) => ({ ...m, capabilities: inferTextCaps(m.model) })),
        builtin: TOKEN_PLAN_BUILTIN,
      })
    } catch (err) {
      json(res, 200, {
        textModels: TOKEN_PLAN_TEXT_BUILTIN,
        builtin: TOKEN_PLAN_BUILTIN,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }
  return false
}

/** 主模型与子模型清单。 */
export async function handleModelListRoute(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'GET' && path === '/api/models') {
    const cfg = loadWebConfig()
    const models = parseWebModels(cfg)
    json(res, 200, {
      models: models ?? [],
      main: cfg.model ?? 'deepseek-v4-flash',
    })
    return true
  }
  return false
}
