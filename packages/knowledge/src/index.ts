import type {
  KnowledgePromptEnhancer,
  KnowledgeRetriever,
  EmbeddingProvider,
} from './types.js'
import { createEmbeddingProvider } from './embeddings.js'
import { FileKnowledgeStore } from './store.js'
import { createRetriever } from './retriever.js'
import { buildKnowledgePrompt } from './enhancer.js'

export type {
  KnowledgeChunk,
  KnowledgeDoc,
  KnowledgePromptEnhancer,
  KnowledgeQuery,
  KnowledgeRetriever,
  KnowledgeHit,
  KnowledgeScope,
  KnowledgeSpace,
  KnowledgeFolder,
  EmbeddingConfig,
  EmbeddingProvider,
} from './types.js'
export { DEFAULT_SPACE_ID } from './types.js'
export { chunkText, type ChunkOptions } from './chunk.js'
export { extractText } from './extract.js'
export { createEmbeddingProvider } from './embeddings.js'
export {
  FileKnowledgeStore,
  defaultKnowledgeDir,
  defaultKnowledgeIndexPath,
  type AddDocumentInput,
  type KnowledgeDocFilter,
} from './store.js'
export { createRetriever } from './retriever.js'
export { buildKnowledgePrompt } from './enhancer.js'

/** 知识库组合配置（运行时一键组装）。 */
export interface KnowledgeBaseOptions {
  /** 索引文件路径。 */
  path?: string
  /** embedding 配置（缺失时降级关键词检索）。 */
  embedding?: { baseUrl?: string; apiKey?: string; model?: string }
  /** 检索作用域过滤。 */
  scope?: 'global' | 'workspace'
  workspace?: string
  /** 排除的专业化 id（已禁用）。 */
  excludeSpecIds?: string[]
  topK?: number
}

/** 组装 store + retriever + prompt 增强器的完整知识库。 */
export interface KnowledgeBase {
  store: FileKnowledgeStore
  retriever: KnowledgeRetriever
  enhancer: KnowledgePromptEnhancer
  provider: EmbeddingProvider
  hasEmbedding: boolean
}

export function createKnowledgeBase(opts: KnowledgeBaseOptions = {}): KnowledgeBase {
  const provider = createEmbeddingProvider(opts.embedding ?? {})
  const store = new FileKnowledgeStore({ path: opts.path, embedding: provider })
  const retriever = createRetriever(store, provider)
  const enhancer = buildKnowledgePrompt(retriever, {
    scope: opts.scope,
    workspace: opts.workspace,
    excludeSpecIds: opts.excludeSpecIds,
    topK: opts.topK,
  })
  return { store, retriever, enhancer, provider, hasEmbedding: provider.available }
}
