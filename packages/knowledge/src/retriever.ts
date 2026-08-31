import type { EmbeddingProvider, KnowledgeHit, KnowledgeQuery, KnowledgeRetriever } from './types.js'
import type { FileKnowledgeStore } from './store.js'

/**
 * 构建检索器：优先语义（cosine），未配置/失败时降级为关键词匹配（CJK 二分词 + 拉丁词元）。
 */
export function createRetriever(store: FileKnowledgeStore, embedding?: EmbeddingProvider): KnowledgeRetriever {
  return {
    async search(query: KnowledgeQuery): Promise<KnowledgeHit[]> {
      const q = (query.q ?? '').trim()
      if (!q) return []
      const topK = Math.max(1, Math.min(20, query.topK ?? 5))
      const docs = await store.docs()
      const chunks = await store.chunks()

      // 建立 chunk → doc 映射 + 过滤
      const docById = new Map(docs.map((d) => [d.id, d]))
      const exclude = new Set(query.excludeSpecIds ?? [])
      const eligible = chunks.filter((c) => {
        const doc = docById.get(c.docId)
        if (!doc) return false
        if (exclude.size && doc.specId && exclude.has(doc.specId)) return false
        if (query.scope && doc.scope !== query.scope) return false
        if (query.workspace && doc.scope === 'workspace' && doc.workspace !== query.workspace) return false
        return true
      })
      if (!eligible.length) return []

      // 语义检索：embedding 可用且命中块有向量
      if (embedding?.available) {
        let qVec: number[] | undefined
        try {
          const vec = await embedding.embed([q])
          qVec = vec[0]
        } catch {
          qVec = undefined
        }
        if (qVec?.length) {
          const scored = eligible.map((c) =>
            c.embedding?.length
              ? { c, score: cosine(qVec, c.embedding) }
              : { c, score: keywordScore(q, c.text) * 0.5 },
          )
          scored.sort((a, b) => b.score - a.score)
          return scored.slice(0, topK).map(({ c, score }) => toHit(c, docById, score))
        }
      }

      // 关键词降级
      const scored = eligible.map((c) => ({ c, score: keywordScore(q, c.text) }))
      scored.sort((a, b) => b.score - a.score)
      return scored
        .filter((s) => s.score > 0)
        .slice(0, topK)
        .map(({ c, score }) => toHit(c, docById, score))
    },
  }
}

function toHit(c: { id: string; docId: string; text: string }, docById: Map<string, { id: string; title: string }>, score: number): KnowledgeHit {
  return {
    chunkId: c.id,
    docId: c.docId,
    docTitle: docById.get(c.docId)?.title ?? '未命名文档',
    text: c.text,
    score: Math.max(0, Math.min(1, score)),
  }
}

/** 归一化向量后求余弦相似度。 */
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 关键词相关度：拉丁词元 + CJK 二元组命中率。 */
function keywordScore(q: string, text: string): number {
  const qTokens = tokenize(q)
  if (!qTokens.length) return 0
  const hay = normalize(text)
  let hits = 0
  for (const t of qTokens) {
    if (hay.includes(t)) hits++
  }
  return hits / qTokens.length
}

function normalize(s: string): string {
  return s.toLowerCase()
}

function tokenize(s: string): string[] {
  const out: string[] = []
  // 拉丁/数字词元
  for (const m of normalize(s).matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  // CJK 二元组
  const cjk = normalize(s).match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    if (run.length === 1) out.push(run)
  }
  return out
}
