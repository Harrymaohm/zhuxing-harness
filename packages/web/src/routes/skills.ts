import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import { normalizeSkillDefinition, validateSkillDefinition } from '@zhuxing/harness-skills'
import { json, readJsonBody } from '../http.js'
import { loadWebConfig } from '../config-store.js'
import { buildSkillCandidates, resolveSkillTargetDir, reviewSkillCandidate } from '../skill-review.js'
import type { RouteContext } from './context.js'

/** 技能管理：列表 / 新增 / 详情 / 删除 / 试跑 / 上传审核 / 安装。 */
export async function handleSkillRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  const url = ctx.url
  // ===== 技能管理 =====
  if (req.method === 'GET' && path === '/api/skills') {
    const store = ctx.runtime.get().skillStore
    const q = url.searchParams.get('q') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const tag = url.searchParams.get('tag')
    const tags = tag ? tag.split(',').map((t) => t.trim()).filter(Boolean) : undefined
    const skills = await store.list({ q, category, tags })
    json(res, 200, { skills })
    return true
  }
  if (req.method === 'POST' && path === '/api/skills') {
    const body = (await readJsonBody(req)) as Partial<SkillDefinition>
    if (!body.name || !body.template) {
      json(res, 400, { error: '缺少 name 或 template' })
      return true
    }
    const store = ctx.runtime.get().skillStore
    const skill = await store.add({
      name: body.name,
      version: body.version,
      description: body.description ?? '',
      icon: body.icon,
      category: body.category,
      tags: body.tags,
      visibility: body.visibility,
      inputs: body.inputs ?? { type: 'object', properties: {}, required: [] },
      tools: body.tools,
      memory: body.memory,
      template: body.template,
    })
    json(res, 200, { skill })
    return true
  }
  if (req.method === 'GET' && path.startsWith('/api/skills/') && path !== '/api/skills') {
    const name = decodeURIComponent(path.slice('/api/skills/'.length))
    const store = ctx.runtime.get().skillStore
    const skill = await store.get(name)
    json(res, skill ? 200 : 404, skill ? { skill } : { error: '未找到' })
    return true
  }
  if (req.method === 'DELETE' && path.startsWith('/api/skills/') && !path.endsWith('/run')) {
    const name = decodeURIComponent(path.slice('/api/skills/'.length))
    const store = ctx.runtime.get().skillStore
    const ok = await store.remove(name)
    json(res, ok ? 200 : 404, { ok })
    return true
  }
  if (req.method === 'POST' && path.startsWith('/api/skills/') && path.endsWith('/run')) {
    const name = decodeURIComponent(path.slice('/api/skills/'.length, -'/run'.length))
    const body = (await readJsonBody(req)) as { args?: Record<string, unknown> }
    const store = ctx.runtime.get().skillStore
    const skill = await store.get(name)
    if (!skill) {
      json(res, 404, { error: '未找到技能' })
      return true
    }
    try {
      const { buildSkillPrompt } = await import('@zhuxing/harness-skills')
      const prompt = buildSkillPrompt(skill, body.args ?? {})
      json(res, 200, { prompt, tools: skill.tools })
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }
  if (req.method === 'POST' && path === '/api/skills/upload') {
    const body = (await readJsonBody(req)) as {
      files?: Array<{ name?: string; dataBase64?: string }>
      review?: boolean
    }
    const files = body.files ?? []
    if (!files.length) {
      json(res, 400, { error: '未上传文件' })
      return true
    }
    const cfg = loadWebConfig()
    let candidates = await buildSkillCandidates(files)
    if (body.review !== false) {
      candidates = await Promise.all(candidates.map((c) => reviewSkillCandidate(c, cfg)))
    }
    json(res, 200, { candidates })
    return true
  }
  if (req.method === 'POST' && path === '/api/skills/install') {
    const body = (await readJsonBody(req)) as { skill?: SkillDefinition; scope?: string }
    const skill = body.skill
    if (!skill?.name || !skill?.template) {
      json(res, 400, { error: '缺少 name 或 template' })
      return true
    }
    const normalized = normalizeSkillDefinition(skill)
    const issues = validateSkillDefinition(normalized)
    if (issues.length) {
      json(res, 400, { error: `技能存在校验问题：${issues.join('；')}` })
      return true
    }
    const store = ctx.runtime.get().skillStore
    const dir = resolveSkillTargetDir(ctx.runtime, body.scope ?? 'global')
    if (!dir) {
      json(res, 400, { error: '安装目录无效' })
      return true
    }
    const added = await store.add(normalized, dir)
    json(res, 200, { skill: added, dir })
    return true
  }
  return false
}
