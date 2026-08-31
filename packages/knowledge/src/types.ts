/** 知识库作用域：global=全局（跨会话/项目共享），workspace=工作区隔离。 */
export type KnowledgeScope = 'global' | 'workspace'

/** 默认知识空间 id（兼容旧数据：未指定空间的文档自动归入默认空间）。 */
export const DEFAULT_SPACE_ID = 'default'

/** 知识空间：一个可命名的知识库（类似 ima 的个人/共享知识库、飞书的知识库）。 */
export interface KnowledgeSpace {
  id: string
  /** 空间名称。 */
  name: string
  /** 空间描述。 */
  description?: string
  /** 是否为默认空间（不可删除）。 */
  builtin?: boolean
  createdAt: number
  updatedAt: number
}

/** 知识目录（文件夹）：隶属于某个知识空间，可多级嵌套（parentId 指向父目录）。 */
export interface KnowledgeFolder {
  id: string
  /** 所属知识空间 id。 */
  spaceId: string
  /** 父目录 id；顶层目录为该空间根目录（null）。 */
  parentId: string | null
  name: string
  createdAt: number
  updatedAt: number
}

/** 知识文档元数据（chunks/embeddings 分离存储）。 */
export interface KnowledgeDoc {
  id: string
  /** 显示标题（来源文件名或自定义）。 */
  title: string
  /** 来源：文件名 / 'paste' / 专业化包 id。 */
  source: string
  scope: KnowledgeScope
  /** workspace 作用域时关联的工作区路径。 */
  workspace?: string
  /** 所属知识空间 id（缺省为默认空间）。 */
  spaceId?: string
  /** 所属目录 id；顶层为该空间根目录（null/缺省）。 */
  folderId?: string | null
  /** 标签（含专业化来源标记 spec:<id>）。 */
  tags?: string[]
  /** 若来自专业化能力包，记录来源 spec id。 */
  specId?: string
  /** 分块数。 */
  chunkCount: number
  /** 原文长度（字符）。 */
  contentLength: number
  createdAt: number
  updatedAt: number
}

/** 单个知识分块（含可选 embedding 向量）。 */
export interface KnowledgeChunk {
  id: string
  docId: string
  /** 块内序号。 */
  index: number
  text: string
  /** 向量化结果；未配置/失败时缺省（检索降级为关键词匹配）。 */
  embedding?: number[]
}

/** 知识库查询。 */
export interface KnowledgeQuery {
  q: string
  scope?: KnowledgeScope
  workspace?: string
  /** 排除的专业化 id（已禁用的能力包不再注入/命中）。 */
  excludeSpecIds?: string[]
  /** 命中返回上限。 */
  topK?: number
}

/** 检索命中。 */
export interface KnowledgeHit {
  chunkId: string
  docId: string
  docTitle: string
  text: string
  /** 相似度/相关度得分（0~1）。 */
  score: number
}

/** 知识库检索器。 */
export interface KnowledgeRetriever {
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>
}

/** embedding 配置（OpenAI 兼容 /embeddings 端点）。 */
export interface EmbeddingConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
}

/** Embedding 提供方：负责把文本段落向量化；不可用时 available=false。 */
export interface EmbeddingProvider {
  readonly available: boolean
  embed(texts: string[]): Promise<number[][]>
}

/** systemPrompt 知识增强器：在基础 prompt 上追加检索到的相关知识。 */
export type KnowledgePromptEnhancer = (basePrompt: string, userInput: string) => Promise<string>
