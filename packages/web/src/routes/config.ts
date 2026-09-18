import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from '../http.js'
import { loadWebConfig, maskWebConfig, parseWebModels, saveWebConfig } from '../config-store.js'
import type { WebConfig } from '../config-store.js'
import type { RouteContext } from './context.js'

/** 配置读取 / 保存（保存后热重载运行时）。 */
export async function handleConfigRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (req.method === 'GET' && path === '/api/config') {
    const cfg = loadWebConfig()
    json(res, 200, maskWebConfig(cfg))
    return true
  }
  if (req.method === 'POST' && path === '/api/config') {
    const body = (await readJsonBody(req)) as Partial<WebConfig>
    const prev = loadWebConfig()
    const allowed: Partial<WebConfig> = {}
    for (const key of ['apiKey', 'baseUrl', 'model', 'workspace', 'level', 'sessionDir', 'multimodal', 'refineInstruction', 'knowledge'] as const) {
      if (body[key] !== undefined) (allowed as Record<string, unknown>)[key] = body[key]
    }
    // 子模型按 id 合并：未提交的 apiKey（前端脱敏后置空）保留旧值
    if (body.models !== undefined) {
      const prevModels = parseWebModels(prev) ?? []
      const nextModels = (Array.isArray(body.models) ? body.models : []).map((m) => {
        const old = prevModels.find((p) => p.id === m.id)
        return m.apiKey === undefined && old?.apiKey ? { ...m, apiKey: old.apiKey } : m
      })
      allowed.models = nextModels
    }
    // 生图模型：apiKey 未提交时保留旧值
    if (body.imageModel !== undefined) {
      const prevImg = prev.imageModel
      allowed.imageModel =
        body.imageModel.apiKey === undefined && prevImg?.apiKey ? { ...body.imageModel, apiKey: prevImg.apiKey } : body.imageModel
    }
    // token-plan：apiKey 未提交时保留旧值
    if (body.tokenPlan !== undefined) {
      const prevTp = prev.tokenPlan
      allowed.tokenPlan =
        body.tokenPlan.apiKey === undefined && prevTp?.apiKey ? { ...body.tokenPlan, apiKey: prevTp.apiKey } : body.tokenPlan
    }
    // 知识库：embedding apiKey 未提交（或为掩码占位）时保留旧值
    if (body.knowledge !== undefined) {
      const prevKb = prev.knowledge
      const kb = body.knowledge
      const maskedKb = !!kb.embedding?.apiKey && kb.embedding.apiKey.includes('***')
      allowed.knowledge =
        maskedKb || (kb.embedding?.apiKey === undefined && !!prevKb?.embedding?.apiKey)
          ? { ...kb, embedding: { ...(prevKb?.embedding ?? {}), ...kb.embedding, apiKey: prevKb?.embedding?.apiKey } }
          : kb
    }
    const merged = { ...prev, ...allowed }
    const p = saveWebConfig(merged)
    // 热重载：配置变更后重建运行时（全量 re-mount，本地单机稳妥优先）
    await ctx.runtime.reload()
    json(res, 200, { ok: true, path: p })
    return true
  }
  return false
}
