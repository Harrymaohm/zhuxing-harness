import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SpecManager } from '@zhuxing/harness-specs'
import { json, readJsonBody } from '../http.js'
import type { RouteContext } from './context.js'

/** 专业化能力包：列表 / 安装 / 启用禁用 / 移除（变更后重建运行时）。 */
export async function handleSpecRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  // ===== 专业化能力包 =====
  // 列出已验证的专业化包（含内置知识文档数量与启用状态）
  if (req.method === 'GET' && path === '/api/specs') {
    const specs = await ctx.runtime.get().specManager.list()
    json(res, 200, { specs })
    return true
  }
  // 安装 zip 能力包（manifest.json + skills/*.yaml + knowledge/*），默认启用
  if (req.method === 'POST' && path === '/api/specs/install') {
    const body = (await readJsonBody(req)) as { data?: string }
    if (!body.data) {
      json(res, 400, { error: '缺少专业化包数据（base64 zip）' })
      return true
    }
    let buf: Buffer
    try {
      buf = Buffer.from(body.data, 'base64')
    } catch {
      json(res, 400, { error: '数据不是有效的 base64' })
      return true
    }
    const specManager = ctx.runtime.get().specManager
    let result: Awaited<ReturnType<SpecManager['install']>>
    try {
      result = await specManager.install(buf)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
      return true
    }
    // 安装后重建运行时：技能目录与知识库同步已启用包的资源
    await ctx.runtime.reload()
    json(res, 200, { ok: true, spec: result.spec })
    return true
  }
  // 启用 / 禁用 / 移除（路径须含 :id）
  if (req.method === 'POST' && path.startsWith('/api/specs/') && (path.endsWith('/enable') || path.endsWith('/disable'))) {
    const id = decodeURIComponent(path.slice('/api/specs/'.length, path.endsWith('/enable') ? -'/enable'.length : -'/disable'.length))
    const enable = path.endsWith('/enable')
    const specManager = ctx.runtime.get().specManager
    const ok = enable ? await specManager.enable(id) : await specManager.disable(id)
    if (!ok) {
      json(res, 404, { error: '未找到专业化包' })
      return true
    }
    await ctx.runtime.reload()
    json(res, 200, { ok: true, enabled: enable })
    return true
  }
  if (req.method === 'DELETE' && path.startsWith('/api/specs/')) {
    const id = decodeURIComponent(path.slice('/api/specs/'.length))
    const specManager = ctx.runtime.get().specManager
    const ok = await specManager.remove(id)
    if (!ok) {
      json(res, 404, { error: '未找到专业化包' })
      return true
    }
    await ctx.runtime.reload()
    json(res, 200, { ok: true })
    return true
  }
  return false
}
