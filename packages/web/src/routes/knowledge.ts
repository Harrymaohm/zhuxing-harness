import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeService } from '@zhuxing/harness-bundle'
import { extractText } from '@zhuxing/harness-knowledge'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import { json, readJsonBody } from '../http.js'
import { loadWebConfig } from '../config-store.js'
import type { RuntimeManager } from '../runtime.js'
import type { RouteContext } from './context.js'

/** 解析知识库存储：默认全局；scope=workspace 时取工作区（无则回退全局）；未启用返回 undefined。 */
function resolveKbStore(
  runtime: RuntimeManager,
  scope?: string,
): { service: KnowledgeService; store: KnowledgeService['global']['store'] } | undefined {
  const service = runtime.get().knowledgeService
  if (!service) return undefined
  const base = scope === 'workspace' ? service.workspace ?? service.global : service.global
  return { service, store: base.store }
}

/** 自生长知识库：文档入库 / 空间与目录 / 问答 / 清空与重建索引。 */
export async function handleKnowledgeRoutes(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  const url = ctx.url
  const runtime = ctx.runtime
  // ===== 自生长知识库 =====
  // 列出知识文档（scope=global/workspace，q 关键字过滤）
  if (req.method === 'GET' && path === '/api/knowledge') {
    const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
    if (!kb) {
      json(res, 200, { enabled: false, hasEmbedding: false, docs: [] })
      return true
    }
    const q = url.searchParams.get('q') ?? undefined
    const spaceId = url.searchParams.get('spaceId') ?? undefined
    const folderId = url.searchParams.get('folderId') ?? undefined
    const docs = await kb.store.list({ q, spaceId, folderId })
    json(res, 200, { enabled: true, hasEmbedding: kb.service.hasEmbedding, docs })
    return true
  }
  // 上传文档入库：支持 files（文件名+base64，自动抽取文本）或直接 text
  if (req.method === 'POST' && path === '/api/knowledge/upload') {
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用（请在设置中开启后重试）' })
      return true
    }
    const body = (await readJsonBody(req)) as {
      scope?: 'global' | 'workspace'
      tags?: string[]
      title?: string
      text?: string
      spaceId?: string
      folderId?: string | null
      files?: Array<{ name?: string; dataBase64?: string }>
    }
    const targetScope = body.scope ?? 'global'
    const store = resolveKbStore(runtime, targetScope)?.store ?? kb.store
    const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : undefined
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : undefined
    const folderId = typeof body.folderId === 'string' ? body.folderId : null
    const added: Array<{ title: string; source: string; chunkCount: number }> = []
    // 直接文本入库
    if (typeof body.text === 'string' && body.text.trim()) {
      const doc = await store.addDocument({
        title: body.title?.trim() || '未命名文档',
        source: '手动输入',
        scope: targetScope,
        text: body.text,
        tags,
        spaceId,
        folderId,
      })
      added.push({ title: doc.title, source: doc.source, chunkCount: doc.chunkCount })
    }
    // 文件批量入库
    for (const file of body.files ?? []) {
      if (!file?.dataBase64) continue
      const name = file.name || 'unknown'
      const buffer = Buffer.from(file.dataBase64, 'base64')
      const text = extractText(name, buffer)
      if (!text.trim()) {
        json(res, 400, { error: `「${name}」未能抽取到文本内容（支持 txt/md/csv/json/yaml/code 及 docx/pptx/xlsx）` })
        return true
      }
      const doc = await store.addDocument({
        title: body.title?.trim() || name.replace(/\.[^.]+$/, ''),
        source: name,
        scope: targetScope,
        text,
        tags,
        spaceId,
        folderId,
      })
      added.push({ title: doc.title, source: doc.source, chunkCount: doc.chunkCount })
    }
    if (!added.length) {
      json(res, 400, { error: '未提供可入库的内容（text 或 files）' })
      return true
    }
    json(res, 200, { ok: true, added })
    return true
  }
  // ===== 多知识空间（ima / 飞书式知识库）=====
  // 列出知识空间（scope=global/workspace，缺省 global）
  if (req.method === 'GET' && path === '/api/knowledge/spaces') {
    const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
    if (!kb) {
      json(res, 200, { spaces: [], defaultSpaceId: undefined })
      return true
    }
    const spaces = await kb.store.spaces()
    json(res, 200, { spaces, defaultSpaceId: spaces.find((s) => s.builtin)?.id })
    return true
  }
  // 创建知识空间
  if (req.method === 'POST' && path === '/api/knowledge/spaces') {
    const body = (await readJsonBody(req)) as { name?: string; description?: string; scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    if (!body.name?.trim()) {
      json(res, 400, { error: '请输入空间名称' })
      return true
    }
    const space = await kb.store.createSpace(body.name, body.description)
    json(res, 200, { space })
    return true
  }
  // 空间下目录列表（可含嵌套层级）
  if (req.method === 'GET' && path.startsWith('/api/knowledge/spaces/') && path.endsWith('/folders')) {
    const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)\/folders$/)
    const kb = resolveKbStore(runtime, url.searchParams.get('scope') ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const spaceId = decodeURIComponent(m[1])
    const folders = await kb.store.folders(spaceId)
    json(res, 200, { folders })
    return true
  }
  // 在空间下创建目录
  if (req.method === 'POST' && path.startsWith('/api/knowledge/spaces/') && path.endsWith('/folders')) {
    const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)\/folders$/)
    const body = (await readJsonBody(req)) as { name?: string; parentId?: string | null; scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const spaceId = decodeURIComponent(m[1])
    if (!body.name?.trim()) {
      json(res, 400, { error: '请输入目录名称' })
      return true
    }
    const folder = await kb.store.createFolder(spaceId, body.name, body.parentId)
    json(res, 200, { folder })
    return true
  }
  // 更新空间（重命名 / 描述）
  if (req.method === 'PATCH' && path.startsWith('/api/knowledge/spaces/')) {
    const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)$/)
    const body = (await readJsonBody(req)) as { name?: string; description?: string; scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const space = await kb.store.updateSpace(decodeURIComponent(m[1]), body)
    json(res, space ? 200 : 404, space ? { space } : { error: '空间不存在' })
    return true
  }
  // 删除空间（级联删除其文档与目录）
  if (req.method === 'DELETE' && path.startsWith('/api/knowledge/spaces/')) {
    const m = path.match(/^\/api\/knowledge\/spaces\/([^/]+)$/)
    const body = (await readJsonBody(req).catch(() => ({}))) as { scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    try {
      const r = await kb.store.deleteSpace(decodeURIComponent(m[1]))
      json(res, 200, { ok: true, docs: r.docs })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
  // 更新目录（重命名 / 移动）
  if (req.method === 'PATCH' && path.startsWith('/api/knowledge/folders/')) {
    const m = path.match(/^\/api\/knowledge\/folders\/([^/]+)$/)
    const body = (await readJsonBody(req)) as { name?: string; parentId?: string | null; scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    try {
      const folder = await kb.store.updateFolder(decodeURIComponent(m[1]), body)
      json(res, folder ? 200 : 404, folder ? { folder } : { error: '目录不存在' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
  // 删除目录（文档移到根目录，子目录上移）
  if (req.method === 'DELETE' && path.startsWith('/api/knowledge/folders/')) {
    const m = path.match(/^\/api\/knowledge\/folders\/([^/]+)$/)
    const body = (await readJsonBody(req).catch(() => ({}))) as { scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const r = await kb.store.deleteFolder(decodeURIComponent(m[1]))
    json(res, 200, { ok: true, docs: r.docs })
    return true
  }
  // 更新单个文档元数据字段（标题/来源/标签/工作区/空间/目录等，运行时立即生效）
  if (req.method === 'PATCH' && path.startsWith('/api/knowledge/docs/')) {
    const m = path.match(/^\/api\/knowledge\/docs\/([^/]+)$/)
    const body = (await readJsonBody(req)) as {
      title?: string
      source?: string
      workspace?: string
      scope?: 'global' | 'workspace'
      specId?: string
      tags?: string[]
      spaceId?: string
      folderId?: string | null
    }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const id = decodeURIComponent(m[1])
    try {
      let doc = await kb.store.updateDocument(id, body)
      if (!doc && kb.service.workspace && kb.store !== kb.service.workspace.store) {
        doc = await kb.service.workspace.store.updateDocument(id, body)
      }
      json(res, doc ? 200 : 404, doc ? { doc } : { error: '文档不存在' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
  // 移动文档到指定空间 / 目录
  if (req.method === 'PATCH' && path.startsWith('/api/knowledge/') && path.endsWith('/move')) {
    const m = path.match(/^\/api\/knowledge\/([^/]+)\/move$/)
    const body = (await readJsonBody(req)) as { spaceId?: string; folderId?: string | null; scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, body.scope ?? undefined)
    if (!m || !kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    if (!body.spaceId) {
      json(res, 400, { error: '缺少目标空间' })
      return true
    }
    try {
      const ok = await kb.store.moveDoc(decodeURIComponent(m[1]), body.spaceId, body.folderId ?? null)
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '文档不存在' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }
  // ===== 知识库问答（带溯源）=====
  if (req.method === 'POST' && path === '/api/knowledge/ask') {
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用（请在设置中开启后重试）' })
      return true
    }
    const body = (await readJsonBody(req)) as { q?: string; scope?: 'global' | 'workspace'; spaceId?: string; topK?: number }
    const q = (body.q ?? '').trim()
    if (!q) {
      json(res, 400, { error: '请输入要提问的内容' })
      return true
    }
    const cfg = loadWebConfig()
    if (!cfg.apiKey || !cfg.model) {
      json(res, 400, { error: '未配置模型，无法进行知识库问答' })
      return true
    }
    const scope = body.scope === 'workspace' ? 'workspace' : 'global'
    const base = scope === 'workspace' ? kb.service.workspace ?? kb.service.global : kb.service.global
    const retriever = base.retriever
    const topK = Math.max(1, Math.min(10, body.topK ?? 5))
    const hits = await retriever.search({
      q,
      scope,
      workspace: scope === 'workspace' ? runtime.workspacePath ?? undefined : undefined,
      topK,
    })
    if (!hits.length) {
      json(res, 200, { answer: '知识库中暂未找到与问题相关的内容。', hits: [] })
      return true
    }
    const provider = new OpenAICompatibleProvider({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model,
    })
    const ctxText = hits.map((h, i) => `[${i + 1}] 来源《${h.docTitle}》：${h.text.trim()}`).join('\n\n')
    const prompt = [
      '你是一个严谨的知识库问答助手。请仅基于下面给定的知识库检索片段回答用户问题。',
      '若引用到片段，请在句末以 [1][2] 形式标注对应来源编号。',
      '若片段不足以回答，请明确说明「知识库中未找到足够依据」。',
      '',
      '知识库片段：',
      ctxText,
      '',
      '用户问题：' + q,
    ].join('\n')
    const result = await provider.chat([
      { role: 'system', content: '你只依据给定知识库片段作答，输出简洁、专业、可溯源的中文回答。' },
      { role: 'user', content: prompt },
    ])
    const answer = (result.content ?? '').trim()
    json(res, 200, { answer, hits })
    return true
  }
  // 删除单个文档
  if (req.method === 'DELETE' && path.startsWith('/api/knowledge/')) {
    const id = decodeURIComponent(path.slice('/api/knowledge/'.length))
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const ok = (await kb.store.remove(id)) || (await (kb.service.workspace?.store ?? kb.store).remove(id))
    json(res, ok ? 200 : 404, { ok })
    return true
  }
  // 清空（scope 缺省清全部）
  if (req.method === 'POST' && path === '/api/knowledge/clear') {
    const body = (await readJsonBody(req)) as { scope?: 'global' | 'workspace' }
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    // 三个分支都必然赋值，无需初值（初值在被读取前一定被覆盖）
    let cleared: number
    if (body.scope === 'workspace' && kb.service.workspace) {
      cleared = await kb.service.workspace.store.clear('workspace')
    } else if (body.scope === 'global') {
      cleared = await kb.store.clear('global')
    } else {
      cleared = await kb.store.clear()
      if (kb.service.workspace) cleared += await kb.service.workspace.store.clear()
    }
    json(res, 200, { cleared })
    return true
  }
  // 为缺失向量的分块补做向量化（配置了 embedding 后重新索引）
  if (req.method === 'POST' && path === '/api/knowledge/reindex') {
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const global = await kb.store.reindex()
    const workspace = kb.service.workspace ? await kb.service.workspace.store.reindex() : { total: 0, embedded: 0 }
    json(res, 200, { global, workspace, hasEmbedding: kb.service.hasEmbedding })
    return true
  }
  // 查看单个词条内容（跨 global/workspace 查找，分块按序拼接）
  if (req.method === 'GET' && path.startsWith('/api/knowledge/')) {
    const id = decodeURIComponent(path.slice('/api/knowledge/'.length))
    const kb = resolveKbStore(runtime, undefined)
    if (!kb) {
      json(res, 400, { error: '知识库未启用' })
      return true
    }
    const globalStore = kb.service.global.store
    const workspaceStore = kb.service.workspace?.store
    let doc = await globalStore.get(id)
    let store = globalStore
    if (!doc && workspaceStore) {
      doc = await workspaceStore.get(id)
      store = workspaceStore
    }
    if (!doc) {
      json(res, 404, { error: '未找到该词条' })
      return true
    }
    const content = (await store.chunks())
      .filter((c) => c.docId === id)
      .sort((a, b) => a.index - b.index)
      .map((c) => c.text)
      .join('\n\n')
    json(res, 200, { doc, content })
    return true
  }
  return false
}
