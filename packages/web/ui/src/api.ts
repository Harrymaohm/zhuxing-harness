import type { SessionItem, SpaceItem, WebConfig } from './types'

let accessToken = ''
let tokenLoaded = false

/** 启动时从 /api/bootstrap 拉取访问令牌（安装态启用认证时使用）。 */
export async function initAccessToken(): Promise<void> {
  if (tokenLoaded) return
  tokenLoaded = true
  try {
    const res = await fetch('/api/bootstrap')
    if (res.ok) {
      const data = (await res.json()) as { token?: string }
      accessToken = data.token ?? ''
    }
  } catch {
    /* 无认证环境忽略 */
  }
}

/** 统一请求头：认证 token + JSON。 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return accessToken ? { ...extra, 'X-Harness-Token': accessToken } : extra
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title }),
  })
  return res.ok
}

export async function fetchSessions(spaceId?: string, archived?: boolean): Promise<SessionItem[]> {
  const params = new URLSearchParams()
  if (spaceId !== undefined) params.set('spaceId', spaceId)
  if (archived !== undefined) params.set('archived', String(archived))
  const qs = params.toString()
  const res = await fetch(`/api/sessions${qs ? `?${qs}` : ''}`, { headers: headers() })
  if (!res.ok) throw new Error(`加载会话失败（HTTP ${res.status}）`)
  return ((await res.json()) as { sessions: SessionItem[] }).sessions
}

export async function archiveSession(id: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: headers() })
  return res.ok
}

export async function unarchiveSession(id: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/unarchive`, { method: 'POST', headers: headers() })
  return res.ok
}

export async function deleteSession(id: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
  return res.ok
}

export interface SpacesResult {
  spaces: SpaceItem[]
  defaultSpace: SpaceItem
}

export async function fetchSpaces(): Promise<SpacesResult> {
  const res = await fetch('/api/spaces', { headers: headers() })
  if (!res.ok) throw new Error(`加载空间失败（HTTP ${res.status}）`)
  return (await res.json()) as SpacesResult
}

export async function createSpace(title: string): Promise<SpaceItem> {
  const res = await fetch('/api/spaces', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`创建空间失败（HTTP ${res.status}）`)
  return ((await res.json()) as { space: SpaceItem }).space
}

export async function renameSpace(id: string, title: string): Promise<boolean> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title }),
  })
  return res.ok
}

export async function removeSpace(id: string): Promise<boolean> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(),
  })
  return res.ok
}

export async function fetchConfig(): Promise<WebConfig> {
  const res = await fetch('/api/config', { headers: headers() })
  if (!res.ok) throw new Error(`加载配置失败（HTTP ${res.status}）`)
  return (await res.json()) as WebConfig
}

/** token-plan 模型条目（文本子模型 / 多模态模型）。 */
export interface TokenPlanModelEntry {
  id?: string
  model: string
  label?: string
  capabilities?: string[]
}

/** 从上游读取 token-plan 模型清单的返回结构。 */
export interface TokenPlanModelsResult {
  /** 文本生成模型（实时上游 / 回退内置清单）。 */
  textModels: TokenPlanModelEntry[]
  /** 多模态模型（生图 / 视频 / 语音 / Realtime 内置清单）。 */
  builtin: {
    imageModels: Array<{ model: string }>
    videoModels: Array<{ model: string; label?: string }>
    voiceModels: Array<{ model: string; label?: string }>
    realtimeModels: Array<{ model: string; label?: string }>
  }
  error?: string
}

/** 调用后端拉取 token-plan 模型清单。 */
export async function fetchTokenPlanModels(): Promise<TokenPlanModelsResult> {
  const res = await apiFetch('/api/token-plan/models')
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `获取 token-plan 模型失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as TokenPlanModelsResult
}

/** 从父会话分叉出独立子会话（未指定 eventId 时复制全部历史）。 */
export async function forkSession(id: string, eventId?: string): Promise<string> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(eventId ? { eventId } : {}),
  })
  if (!res.ok) throw new Error(`分叉会话失败（HTTP ${res.status}）`)
  return ((await res.json()) as { sessionId: string }).sessionId
}

/** 把子会话结论合并回主会话。 */
export async function mergeSession(id: string, childId: string, summary?: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/merge`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ childId, summary }),
  })
  return res.ok
}

/** 供 fetch 调用注入 token（App 内 fetch 使用）。 */
export function withToken(headersInit: HeadersInit = {}): HeadersInit {
  return accessToken ? { ...headersInit, 'X-Harness-Token': accessToken } : headersInit
}

/** 统一 fetch 包装：先确保 token 已就绪，再自动携带认证 token。 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // 等待 token 加载完成，避免知识库等业务请求在 initAccessToken 完成前发起而 401
  await initAccessToken()
  return fetch(input, {
    ...init,
    headers: accessToken ? { ...(init.headers ?? {}), 'X-Harness-Token': accessToken } : init.headers,
  })
}

// ============ 应用内更新 ============

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  releaseNotes?: string
  error?: string
}

export interface UpdateActionResult {
  ok: boolean
  message?: string
  error?: string
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  const res = await apiFetch('/api/update/check')
  if (!res.ok) throw new Error(`检查更新失败（HTTP ${res.status}）`)
  return (await res.json()) as UpdateCheckResult
}

export async function triggerUpdate(): Promise<UpdateActionResult> {
  const res = await apiFetch('/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return (await res.json()) as UpdateActionResult
}

/** 手动安装本地增量包（base64 内容 + 文件名）。 */
export async function installUpdateZip(data: string, name: string): Promise<UpdateActionResult> {
  const res = await apiFetch('/api/update/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, name }),
  })
  return (await res.json()) as UpdateActionResult
}

/** 上传拖拽文件内容到临时 drops 目录，返回可访问路径（浏览器拿不到本地绝对路径时的兜底）。 */
export async function uploadDropFile(name: string, dataBase64: string): Promise<string> {
  const res = await apiFetch('/api/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data: dataBase64 }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `上传失败（HTTP ${res.status}）`)
  }
  return ((await res.json()) as { path: string }).path
}

/** 一键生成临时工作区目录，返回绝对路径；失败返回 null。 */
export async function createTempWorkspace(): Promise<string | null> {
  const res = await apiFetch('/api/workspace/temp', { method: 'POST' })
  if (!res.ok) return null
  return ((await res.json()) as { path?: string }).path ?? null
}

/** 弹出本地目录选择器，返回选中目录绝对路径；取消或失败返回 null。 */
export async function pickWorkspaceDir(): Promise<string | null> {
  const res = await apiFetch('/api/workspace/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { path?: string; canceled?: boolean }
  return data.canceled ? null : (data.path ?? null)
}

// ============ 自生长知识库 ============

/** 知识空间（类似 ima / 飞书的知识库，可多库切换）。 */
export interface KnowledgeSpace {
  id: string
  name: string
  description?: string
  builtin?: boolean
  createdAt: number
  updatedAt: number
}

/** 知识目录（文件夹），隶属某空间，可多级嵌套。 */
export interface KnowledgeFolder {
  id: string
  spaceId: string
  parentId: string | null
  name: string
  createdAt: number
  updatedAt: number
}

/** 知识文档元数据（与服务端 KnowledgeDoc 对齐）。 */
export interface KnowledgeDoc {
  id: string
  title: string
  source: string
  scope: 'global' | 'workspace'
  workspace?: string
  spaceId?: string
  folderId?: string | null
  tags?: string[]
  specId?: string
  chunkCount: number
  contentLength: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeListResult {
  enabled: boolean
  hasEmbedding: boolean
  docs: KnowledgeDoc[]
}

/** 单个词条详情（含分块拼接后的完整内容）。 */
export interface KnowledgeDocDetail extends KnowledgeDoc {
  content: string
}

/** 列出知识文档（scope/spaceId/folderId/q 过滤）。 */
export async function fetchKnowledgeDocs(
  opts: { scope?: 'global' | 'workspace'; spaceId?: string; folderId?: string; q?: string } = {},
): Promise<KnowledgeListResult> {
  const params = new URLSearchParams()
  if (opts.scope) params.set('scope', opts.scope)
  if (opts.spaceId) params.set('spaceId', opts.spaceId)
  if (opts.folderId) params.set('folderId', opts.folderId)
  if (opts.q) params.set('q', opts.q)
  const qs = params.toString()
  const res = await apiFetch(`/api/knowledge${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`加载知识库失败（HTTP ${res.status}）`)
  return (await res.json()) as KnowledgeListResult
}

/** 获取单个词条详情内容。 */
export async function fetchKnowledgeDoc(id: string): Promise<KnowledgeDocDetail> {
  const res = await apiFetch(`/api/knowledge/${encodeURIComponent(id)}`)
  if (res.status === 404) throw new Error('词条不存在或已被删除')
  if (!res.ok) throw new Error(`加载词条失败（HTTP ${res.status}）`)
  const data = (await res.json()) as { doc?: KnowledgeDoc; content?: string }
  if (!data.doc) throw new Error('词条不存在')
  return { ...data.doc, content: data.content ?? '' }
}

export interface KnowledgeUploadInput {
  scope?: 'global' | 'workspace'
  title?: string
  tags?: string[]
  spaceId?: string
  folderId?: string | null
  text?: string
  files?: Array<{ name?: string; dataBase64?: string }>
}

/** 上传知识文档入库（文本 / 文件批量；服务端自动分块 + 可选向量化）。 */
export async function uploadKnowledge(input: KnowledgeUploadInput): Promise<{ added: Array<{ title: string; source: string; chunkCount: number }> }> {
  const res = await apiFetch('/api/knowledge/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `上传失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as { added: Array<{ title: string; source: string; chunkCount: number }> }
}

// ============ 多知识空间对齐（ima / 飞书式知识库）============

export interface KnowledgeSpacesResult {
  spaces: KnowledgeSpace[]
  defaultSpaceId?: string
}

/** 列出知识空间。 */
export async function fetchKnowledgeSpaces(scope?: 'global' | 'workspace'): Promise<KnowledgeSpacesResult> {
  const params = scope ? `?scope=${scope}` : ''
  const res = await apiFetch(`/api/knowledge/spaces${params}`)
  if (!res.ok) throw new Error(`加载知识空间失败（HTTP ${res.status}）`)
  return (await res.json()) as KnowledgeSpacesResult
}

/** 创建知识空间。 */
export async function createKnowledgeSpace(name: string, description?: string, scope?: 'global' | 'workspace'): Promise<KnowledgeSpace> {
  const res = await apiFetch('/api/knowledge/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, scope }),
  })
  if (!res.ok) throw new Error((((await res.json().catch(() => ({}))) as { error?: string }).error) ?? `创建空间失败（HTTP ${res.status}）`)
  return ((await res.json()) as { space: KnowledgeSpace }).space
}

/** 更新知识空间（重命名 / 描述）。 */
export async function updateKnowledgeSpace(id: string, patch: { name?: string; description?: string }, scope?: 'global' | 'workspace'): Promise<boolean> {
  const res = await apiFetch(`/api/knowledge/spaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, scope }),
  })
  return res.ok
}

/** 删除知识空间（级联删除其文档与目录）。 */
export async function deleteKnowledgeSpace(id: string, scope?: 'global' | 'workspace'): Promise<number> {
  const res = await apiFetch(`/api/knowledge/spaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })
  if (!res.ok) throw new Error((((await res.json().catch(() => ({}))) as { error?: string }).error) ?? `删除空间失败（HTTP ${res.status}）`)
  return ((await res.json().catch(() => ({}))) as { docs?: number }).docs ?? 0
}

/** 列出某空间下的目录（含嵌套）。 */
export async function fetchKnowledgeFolders(spaceId: string, scope?: 'global' | 'workspace'): Promise<KnowledgeFolder[]> {
  const params = scope ? `?scope=${scope}` : ''
  const res = await apiFetch(`/api/knowledge/spaces/${encodeURIComponent(spaceId)}/folders${params}`)
  if (!res.ok) throw new Error(`加载目录失败（HTTP ${res.status}）`)
  return ((await res.json()) as { folders: KnowledgeFolder[] }).folders
}

/** 在空间下创建目录（parentId 可嵌套）。 */
export async function createKnowledgeFolder(spaceId: string, name: string, parentId?: string | null, scope?: 'global' | 'workspace'): Promise<KnowledgeFolder> {
  const res = await apiFetch(`/api/knowledge/spaces/${encodeURIComponent(spaceId)}/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parentId, scope }),
  })
  if (!res.ok) throw new Error((((await res.json().catch(() => ({}))) as { error?: string }).error) ?? `创建目录失败（HTTP ${res.status}）`)
  return ((await res.json()) as { folder: KnowledgeFolder }).folder
}

/** 更新目录（重命名 / 移动）。 */
export async function updateKnowledgeFolder(id: string, patch: { name?: string; parentId?: string | null }, scope?: 'global' | 'workspace'): Promise<boolean> {
  const res = await apiFetch(`/api/knowledge/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, scope }),
  })
  return res.ok
}

/** 删除目录（文档移到根目录，子目录上移）。 */
export async function deleteKnowledgeFolder(id: string, scope?: 'global' | 'workspace'): Promise<number> {
  const res = await apiFetch(`/api/knowledge/folders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  })
  if (!res.ok) throw new Error((((await res.json().catch(() => ({}))) as { error?: string }).error) ?? `删除目录失败（HTTP ${res.status}）`)
  return ((await res.json().catch(() => ({}))) as { docs?: number }).docs ?? 0
}

/** 移动文档到指定空间 / 目录。 */
export async function moveKnowledgeDoc(id: string, spaceId: string, folderId?: string | null, scope?: 'global' | 'workspace'): Promise<boolean> {
  const res = await apiFetch(`/api/knowledge/${encodeURIComponent(id)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId, folderId, scope }),
  })
  return res.ok
}

/** 知识库问答检索命中（溯源）。 */
export interface KnowledgeHit {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  score: number
}

/** 知识库问答（检索 → 生成 → 返回答案与溯源命中）。 */
export async function askKnowledge(input: { q: string; scope?: 'global' | 'workspace'; spaceId?: string; topK?: number }): Promise<{ answer: string; hits: KnowledgeHit[] }> {
  const res = await apiFetch('/api/knowledge/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error((((await res.json().catch(() => ({}))) as { error?: string }).error) ?? `知识库问答失败（HTTP ${res.status}）`)
  return (await res.json()) as { answer: string; hits: KnowledgeHit[] }
}

/** 删除单个知识文档。 */
export async function deleteKnowledgeDoc(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

/** 清空知识库（scope 缺省清全部）。 */
export async function clearKnowledge(scope?: 'global' | 'workspace'): Promise<number> {
  const res = await apiFetch('/api/knowledge/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope ? { scope } : {}),
  })
  return res.ok ? ((await res.json().catch(() => ({}))) as { cleared?: number }).cleared ?? 0 : 0
}

/** 为缺失向量的分块补做向量化（配置 embedding 后重新索引）。 */
export async function reindexKnowledge(): Promise<{ global: { total: number; embedded: number }; workspace: { total: number; embedded: number }; hasEmbedding: boolean }> {
  const res = await apiFetch('/api/knowledge/reindex', { method: 'POST' })
  if (!res.ok) throw new Error(`重建索引失败（HTTP ${res.status}）`)
  return (await res.json()) as { global: { total: number; embedded: number }; workspace: { total: number; embedded: number }; hasEmbedding: boolean }
}

// ============ 专业化能力包 ============

/** 已安装的专业化包记录（与服务端 SpecRecord 对齐）。 */
export interface SpecRecord {
  id: string
  name: string
  version: string
  description?: string
  category?: string
  icon?: string
  enabled: boolean
  skillCount: number
  knowledgeCount: number
  installedAt: number
}

/** 列出所有已安装的专业化包。 */
export async function fetchSpecs(): Promise<SpecRecord[]> {
  const res = await apiFetch('/api/specs')
  if (!res.ok) throw new Error(`加载专业化包失败（HTTP ${res.status}）`)
  return ((await res.json()) as { specs: SpecRecord[] }).specs
}

/** 安装 zip 能力包（base64 内容），默认启用。 */
export async function installSpec(dataBase64: string): Promise<SpecRecord> {
  const res = await apiFetch('/api/specs/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: dataBase64 }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `安装失败（HTTP ${res.status}）`)
  }
  return ((await res.json()) as { spec: SpecRecord }).spec
}

/** 启用 / 禁用专业化包。 */
export async function setSpecEnabled(id: string, enabled: boolean): Promise<boolean> {
  const res = await apiFetch(`/api/specs/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })
  return res.ok
}

/** 移除专业化包。 */
export async function removeSpec(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/specs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}
