import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { chunkText } from './chunk.js'
import { DEFAULT_SPACE_ID } from './types.js'
import type {
  EmbeddingProvider,
  KnowledgeChunk,
  KnowledgeDoc,
  KnowledgeFolder,
  KnowledgeScope,
  KnowledgeSpace,
} from './types.js'

/** 默认知识库目录：~/.zhuxing-harness/knowledge */
export function defaultKnowledgeDir(): string {
  return process.env.HARNESS_KNOWLEDGE_DIR ?? join(homedir(), '.zhuxing-harness', 'knowledge')
}

/** 默认索引文件路径（docs + chunks + embeddings 序列化）。 */
export function defaultKnowledgeIndexPath(dir: string = defaultKnowledgeDir()): string {
  return join(dir, 'index.json')
}

/** 生成短 ID。 */
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface IndexData {
  spaces: KnowledgeSpace[]
  folders: KnowledgeFolder[]
  docs: KnowledgeDoc[]
  chunks: KnowledgeChunk[]
}

/** 文档入库输入（内容在入参给出，由 store 分块/向量化）。 */
export interface AddDocumentInput {
  title: string
  source: string
  scope: KnowledgeScope
  workspace?: string
  text: string
  tags?: string[]
  specId?: string
  /** 所属知识空间 id（缺省默认空间）。 */
  spaceId?: string
  /** 所属目录 id（缺省根目录）。 */
  folderId?: string | null
  /** 分块大小（缺省用默认）。 */
  chunkSize?: number
}

/** 文档列表过滤。 */
export interface KnowledgeDocFilter {
  scope?: KnowledgeScope
  workspace?: string
  specId?: string
  spaceId?: string
  folderId?: string
  q?: string
}

/** 文档字段更新输入：仅更新提供的字段（title 空串忽略，tags 空数组清空）。 */
export interface UpdateDocumentInput {
  title?: string
  source?: string
  workspace?: string
  scope?: KnowledgeScope
  specId?: string
  tags?: string[]
  spaceId?: string
  folderId?: string | null
}

/**
 * 文件形式知识库存储：文档元数据 + 分块 + 向量一起序列化到一个 JSON 索引文件。
 * 写入权限 600，与 config/memories 对齐。
 */
export class FileKnowledgeStore {
  private path: string
  private embedding?: EmbeddingProvider
  private cache?: IndexData

  constructor(opts: { path?: string; embedding?: EmbeddingProvider } = {}) {
    this.path = opts.path ?? defaultKnowledgeIndexPath()
    this.embedding = opts.embedding
  }

  /** 是否具备向量化能力（决定检索是否走语义召回）。 */
  get hasEmbedding(): boolean {
    return this.embedding?.available ?? false
  }

  private load(): IndexData {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf-8').trim()
        if (raw) {
          const data = JSON.parse(raw) as Partial<IndexData>
          this.cache = this.normalize(data.docs ?? [], data.chunks ?? [], data.spaces ?? [], data.folders ?? [])
          return this.cache
        }
      }
    } catch {
      /* 损坏时从空开始 */
    }
    this.cache = this.normalize([], [], [], [])
    return this.cache
  }

  /** 载入时归一化：确保默认空间存在；为旧文档补齐空间/目录字段；清理失效目录引用。 */
  private normalize(
    docs: KnowledgeDoc[],
    chunks: KnowledgeChunk[],
    spaces: KnowledgeSpace[],
    folders: KnowledgeFolder[],
  ): IndexData {
    const sp = [...spaces]
    if (!sp.some((s) => s.id === DEFAULT_SPACE_ID)) {
      const now = Date.now()
      sp.unshift({
        id: DEFAULT_SPACE_ID,
        name: '默认知识库',
        description: '未指定空间的知识文档自动归档于此',
        builtin: true,
        createdAt: now,
        updatedAt: now,
      })
    }
    const folderIds = new Set(folders.map((f) => f.id))
    const normalizedDocs = docs.map((doc) => {
      const spaceId = doc.spaceId && sp.some((s) => s.id === doc.spaceId) ? doc.spaceId : DEFAULT_SPACE_ID
      const folderId = doc.folderId && folderIds.has(doc.folderId) ? doc.folderId : null
      return { ...doc, spaceId, folderId }
    })
    return { spaces: sp, folders, docs: normalizedDocs, chunks }
  }

  private flush(): void {
    if (!this.cache) return
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.cache, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  async list(filter?: KnowledgeDocFilter): Promise<KnowledgeDoc[]> {
    let docs = this.load().docs
    if (filter?.scope) docs = docs.filter((d) => d.scope === filter.scope)
    if (filter?.workspace) docs = docs.filter((d) => d.workspace === filter.workspace)
    if (filter?.specId) docs = docs.filter((d) => d.specId === filter.specId)
    if (filter?.spaceId) docs = docs.filter((d) => d.spaceId === filter.spaceId)
    if (filter?.folderId) docs = docs.filter((d) => d.folderId === filter.folderId)
    if (filter?.q) {
      const q = filter.q.toLowerCase()
      docs = docs.filter((d) => `${d.title} ${d.source} ${d.tags?.join(' ') ?? ''}`.toLowerCase().includes(q))
    }
    return [...docs].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 全部知识空间（默认空间置顶）。 */
  async spaces(): Promise<KnowledgeSpace[]> {
    const list = [...this.load().spaces]
    return list.sort((a, b) => Number(a.builtin === true) - Number(b.builtin === true) || a.createdAt - b.createdAt)
  }

  /** 创建知识空间。 */
  async createSpace(name: string, description?: string): Promise<KnowledgeSpace> {
    const data = this.load()
    const now = Date.now()
    const space: KnowledgeSpace = {
      id: genId(),
      name: name.trim() || '未命名空间',
      description: description?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    }
    data.spaces.push(space)
    this.flush()
    return space
  }

  /** 重命名 / 更新知识空间描述。 */
  async updateSpace(id: string, patch: { name?: string; description?: string }): Promise<KnowledgeSpace | undefined> {
    const data = this.load()
    const space = data.spaces.find((s) => s.id === id)
    if (!space) return undefined
    if (typeof patch.name === 'string' && patch.name.trim()) space.name = patch.name.trim()
    if (patch.description !== undefined) space.description = patch.description?.trim() ? patch.description.trim() : undefined
    space.updatedAt = Date.now()
    this.flush()
    return space
  }

  /** 删除知识空间（级联删除其目录与文档）。返回被删除的文档数。 */
  async deleteSpace(id: string): Promise<{ docs: number }> {
    const data = this.load()
    if (id === DEFAULT_SPACE_ID) throw new Error('默认知识空间不可删除')
    const exists = data.spaces.some((s) => s.id === id)
    if (!exists) return { docs: 0 }
    const docIds = new Set(data.docs.filter((d) => d.spaceId === id).map((d) => d.id))
    const n = docIds.size
    data.spaces = data.spaces.filter((s) => s.id !== id)
    data.folders = data.folders.filter((f) => f.spaceId !== id)
    data.docs = data.docs.filter((d) => d.spaceId !== id)
    data.chunks = data.chunks.filter((c) => !docIds.has(c.docId))
    this.flush()
    return { docs: n }
  }

  /** 列出目录（可按空间过滤）。 */
  async folders(spaceId?: string): Promise<KnowledgeFolder[]> {
    const list = this.load().folders
    const filtered = spaceId ? list.filter((f) => f.spaceId === spaceId) : list
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  /** 在指定空间创建目录（parentId 可嵌套）。 */
  async createFolder(spaceId: string, name: string, parentId?: string | null): Promise<KnowledgeFolder> {
    const data = this.load()
    if (!data.spaces.some((s) => s.id === spaceId)) throw new Error('知识空间不存在')
    const parent = parentId ?? null
    if (parent && !data.folders.some((f) => f.id === parent && f.spaceId === spaceId)) throw new Error('父目录不存在')
    const now = Date.now()
    const folder: KnowledgeFolder = {
      id: genId(),
      spaceId,
      parentId: parent,
      name: name.trim() || '未命名目录',
      createdAt: now,
      updatedAt: now,
    }
    data.folders.push(folder)
    this.flush()
    return folder
  }

  /** 重命名 / 移动目录。 */
  async updateFolder(id: string, patch: { name?: string; parentId?: string | null }): Promise<KnowledgeFolder | undefined> {
    const data = this.load()
    const folder = data.folders.find((f) => f.id === id)
    if (!folder) return undefined
    if (typeof patch.name === 'string' && patch.name.trim()) folder.name = patch.name.trim()
    if (patch.parentId !== undefined) {
      if (patch.parentId !== null && !data.folders.some((f) => f.id === patch.parentId && f.spaceId === folder.spaceId)) {
        throw new Error('父目录不存在')
      }
      folder.parentId = patch.parentId
    }
    folder.updatedAt = Date.now()
    this.flush()
    return folder
  }

  /** 删除目录：其下文档移到根目录，子目录上移到父目录。返回被移动的文档数。 */
  async deleteFolder(id: string): Promise<{ docs: number }> {
    const data = this.load()
    const folder = data.folders.find((f) => f.id === id)
    if (!folder) return { docs: 0 }
    const n = data.docs.filter((d) => d.folderId === id).length
    for (const d of data.docs) if (d.folderId === id) d.folderId = null
    for (const child of data.folders) if (child.parentId === id) child.parentId = folder.parentId
    data.folders = data.folders.filter((f) => f.id !== id)
    this.flush()
    return { docs: n }
  }

  /** 移动文档到指定空间 / 目录（folderId 为 null 表示该空间根目录）。 */
  async moveDoc(id: string, spaceId: string, folderId?: string | null): Promise<boolean> {
    const data = this.load()
    const doc = data.docs.find((d) => d.id === id)
    if (!doc) return false
    if (!data.spaces.some((s) => s.id === spaceId)) throw new Error('目标知识空间不存在')
    if (folderId && !data.folders.some((f) => f.id === folderId && f.spaceId === spaceId)) throw new Error('目标目录不存在')
    doc.spaceId = spaceId
    doc.folderId = folderId ?? null
    doc.updatedAt = Date.now()
    this.flush()
    return true
  }

  /**
   * 更新单个文档的元数据字段（运行时直接改内存 cache 并 flush，无需重启即可生效）。
   * 支持改 title/source/tags/workspace/specId/scope，以及空间/目录（spaceId/folderId）归属。
   */
  async updateDocument(id: string, patch: UpdateDocumentInput): Promise<KnowledgeDoc | undefined> {
    const data = this.load()
    const doc = data.docs.find((d) => d.id === id)
    if (!doc) return undefined
    let targetSpaceId = doc.spaceId ?? DEFAULT_SPACE_ID
    let targetFolderId = doc.folderId ?? null
    if (patch.spaceId !== undefined) {
      if (!data.spaces.some((s) => s.id === patch.spaceId)) throw new Error('目标知识空间不存在')
      targetSpaceId = patch.spaceId
    }
    if (patch.folderId !== undefined) {
      if (patch.folderId !== null && !data.folders.some((f) => f.id === patch.folderId && f.spaceId === targetSpaceId)) {
        throw new Error('目标目录不存在')
      }
      targetFolderId = patch.folderId
    }
    if (typeof patch.title === 'string' && patch.title.trim()) doc.title = patch.title.trim()
    if (typeof patch.source === 'string') doc.source = patch.source.trim()
    if (patch.workspace !== undefined) doc.workspace = patch.workspace?.trim() || undefined
    if (patch.scope !== undefined) doc.scope = patch.scope
    if (patch.specId !== undefined) doc.specId = patch.specId?.trim() || undefined
    if (patch.tags !== undefined) doc.tags = patch.tags.length ? patch.tags.map((t) => String(t).trim()).filter(Boolean) : undefined
    doc.spaceId = targetSpaceId
    doc.folderId = targetFolderId
    doc.updatedAt = Date.now()
    this.flush()
    return doc
  }

  async get(id: string): Promise<KnowledgeDoc | undefined> {
    return this.load().docs.find((d) => d.id === id)
  }

  /** 全部文档（用于检索时构建 doc 映射）。 */
  async docs(): Promise<KnowledgeDoc[]> {
    return [...this.load().docs]
  }

  /** 全部分块（用于检索时做相似度/关键词匹配）。 */
  async chunks(): Promise<KnowledgeChunk[]> {
    return [...this.load().chunks]
  }

  /** 入库：分块 → 向量化（失败降级为无向量）→ 持久化。 */
  async addDocument(input: AddDocumentInput): Promise<KnowledgeDoc> {
    const data = this.load()
    const text = input.text.trim()
    const size = input.chunkSize ?? 800
    const pieces = chunkText(text, { size })
    const now = Date.now()
    const spaceId = input.spaceId && data.spaces.some((s) => s.id === input.spaceId) ? input.spaceId : DEFAULT_SPACE_ID
    const folderId = input.folderId && data.folders.some((f) => f.id === input.folderId && f.spaceId === spaceId) ? input.folderId : null
    const doc: KnowledgeDoc = {
      id: genId(),
      title: input.title.trim() || '未命名文档',
      source: input.source,
      scope: input.scope,
      workspace: input.workspace,
      spaceId,
      folderId,
      tags: input.tags?.length ? input.tags : undefined,
      specId: input.specId,
      chunkCount: pieces.length,
      contentLength: text.length,
      createdAt: now,
      updatedAt: now,
    }
    // 批量向量化（一次性请求所有 chunks）
    let embeddings: number[][] | undefined
    if (this.embedding?.available && pieces.length) {
      try {
        embeddings = await this.embedding.embed(pieces)
      } catch {
        embeddings = undefined
      }
    }
    const chunks: KnowledgeChunk[] = pieces.map((p, i) => ({
      id: genId(),
      docId: doc.id,
      index: i,
      text: p,
      embedding: embeddings?.[i]?.length ? embeddings[i] : undefined,
    }))
    data.docs.push(doc)
    data.chunks.push(...chunks)
    this.flush()
    return doc
  }

  /** 删除文档及其全部分块。 */
  async remove(id: string): Promise<boolean> {
    const data = this.load()
    const before = data.docs.length
    data.docs = data.docs.filter((d) => d.id !== id)
    if (data.docs.length === before) return false
    data.chunks = data.chunks.filter((c) => c.docId !== id)
    this.flush()
    return true
  }

  /** 清空（可按作用域）。 */
  async clear(scope?: KnowledgeScope): Promise<number> {
    const data = this.load()
    if (!scope) {
      const n = data.docs.length
      data.docs = []
      data.chunks = []
      this.flush()
      return n
    }
    const docIds = new Set(data.docs.filter((d) => d.scope === scope).map((d) => d.id))
    const before = data.docs.length
    data.docs = data.docs.filter((d) => d.scope !== scope)
    data.chunks = data.chunks.filter((c) => !docIds.has(c.docId))
    this.flush()
    return before - data.docs.length
  }

  /** 为缺失向量的分块补做向量化（配置了 embedding 后重新索引）。 */
  async reindex(): Promise<{ total: number; embedded: number }> {
    const data = this.load()
    if (!this.embedding?.available) return { total: data.chunks.length, embedded: 0 }
    const missing = data.chunks.filter((c) => !c.embedding?.length)
    if (!missing.length) return { total: data.chunks.length, embedded: 0 }
    try {
      const vecs = await this.embedding.embed(missing.map((c) => c.text))
      missing.forEach((c, i) => {
        if (vecs[i]?.length) c.embedding = vecs[i]
      })
      this.flush()
    } catch {
      /* 失败保持现状 */
    }
    return { total: data.chunks.length, embedded: missing.length }
  }
}

export type { IndexData }
