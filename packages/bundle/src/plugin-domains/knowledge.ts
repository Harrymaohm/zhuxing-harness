/** 知识库插件：自生长知识库（文档 → 分块 → 向量化 → RAG 检索注入 + search_knowledge 工具）。 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { createKnowledgeBase, defaultKnowledgeIndexPath } from '@zhuxing/harness-knowledge'
import type { KnowledgeBase, KnowledgeHit, KnowledgePromptEnhancer, KnowledgeRetriever } from '@zhuxing/harness-knowledge'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions, KnowledgeService } from '../options.js'

/**
 * @param deps.workspace 已 resolve 的绝对工作区路径（检索时作为工作区上下文）
 */
export function knowledgePlugins(deps: Pick<BaseBundleOptions, 'workspace' | 'knowledge'>): PluginDefinition[] {
  return [
    {
      name: 'harness-knowledge',
      description:
        '自生长知识库：文档上传 → 分块 → 向量化（OpenAI 兼容 embeddings，缺省降级关键词检索）→ RAG 检索注入（注册 search_knowledge 工具）',
      inject: ['tools'],
      apply(ctx) {
        const knowledge = deps.knowledge
        if (!knowledge?.enabled) return

        const embedding = knowledge.embedding
        const kbGlobal = createKnowledgeBase({
          path: knowledge.path ?? defaultKnowledgeIndexPath(),
          embedding,
          scope: knowledge.scope,
          topK: knowledge.topK,
        })
        let kbWorkspace: KnowledgeBase | undefined
        if (knowledge.workspacePath) {
          kbWorkspace = createKnowledgeBase({ path: knowledge.workspacePath, embedding, scope: 'workspace', topK: knowledge.topK })
        }

        const retrievers: KnowledgeRetriever[] = [kbGlobal.retriever]
        if (kbWorkspace) retrievers.push(kbWorkspace.retriever)
        const disabledSpecIds = new Set<string>(knowledge.excludeSpecIds ?? [])

        // 合并检索器：聚合多个存储（全局 + 工作区）的结果，按分数排序去重。
        const combinedRetriever: KnowledgeRetriever = {
          async search(query) {
            const per = Math.max(2, Math.ceil((query.topK ?? knowledge.topK ?? 4) * 2))
            const exclude = Array.from(disabledSpecIds)
            const results: KnowledgeHit[] = []
            for (const r of retrievers) {
              try {
                results.push(...(await r.search({ ...query, excludeSpecIds: exclude, topK: per })))
              } catch {
                /* 单存储检索失败时忽略，保持其余结果 */
              }
            }
            results.sort((a, b) => b.score - a.score)
            const seen = new Set<string>()
            const dedup = results.filter((h) => {
              if (seen.has(h.chunkId)) return false
              seen.add(h.chunkId)
              return true
            })
            return dedup.slice(0, query.topK ?? knowledge.topK ?? 4)
          },
        }

        // 知识注入增强器：检索相关块追加到 systemPrompt（上限 8KB）。
        const maxChars = 8192
        const enhancer: KnowledgePromptEnhancer = async (basePrompt, userInput) => {
          try {
            const hits = await combinedRetriever.search({
              q: userInput,
              scope: knowledge.scope,
              topK: knowledge.topK ?? 4,
            })
            if (!hits.length) return basePrompt
            const lines: string[] = []
            let total = 0
            for (const h of hits) {
              const line = `- [${h.docTitle}] ${h.text.trim()}`
              if (total + line.length + 1 > maxChars) break
              lines.push(line)
              total += line.length + 1
            }
            if (!lines.length) return basePrompt
            const block = `\n\n# Knowledge Base Context\nThe following are relevant excerpts from the user's knowledge base. Use them as authoritative background when answering the current question:\n${lines.join('\n')}`
            return basePrompt + block
          } catch {
            return basePrompt
          }
        }

        // 对外可调整的启用/禁用专业化集合（禁用包的知识文档不参与检索）。
        const service: KnowledgeService = {
          enabled: true,
          global: kbGlobal,
          workspace: kbWorkspace,
          provider: kbGlobal.provider,
          hasEmbedding: kbGlobal.hasEmbedding,
          setExcludedSpecs(ids: string[]): void {
            disabledSpecIds.clear()
            for (const id of ids) disabledSpecIds.add(id)
          },
        }
        ctx.provide('knowledgeStore', kbGlobal.store)
        ctx.provide('knowledgeEnhancer', enhancer)
        ctx.provide('knowledgeService', service)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterSearch = tools.register({
          name: 'search_knowledge',
          description:
            '检索知识库中与问题相关的文档片段（RAG）。参数：q（必填，检索词）、scope（可选，global/workspace）、topK（可选，默认 4）。' +
            '返回命中片段、来源文档标题与相关度分数。',
          schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: '检索词' },
              scope: { type: 'string', enum: ['global', 'workspace'], description: '检索作用域（默认不限）' },
              topK: { type: 'integer', description: '返回条数（默认 4）' },
            },
            required: ['q'],
          },
          execute: async (args) => {
            const q = String(args.q ?? '').trim()
            if (!q) return { error: '缺少 q 参数' }
            const scope = typeof args.scope === 'string' ? (args.scope as 'global' | 'workspace') : undefined
            const topK = typeof args.topK === 'number' ? args.topK : undefined
            const hits = await combinedRetriever.search({ q, scope, topK, workspace: deps.workspace ?? undefined })
            if (!hits.length) return { json: [], text: '知识库中未检索到相关内容' }
            const lines = hits.map((h) => `- [${h.docTitle}] (score ${h.score.toFixed(2)}) ${h.text.trim()}`)
            return { json: hits, text: `命中 ${hits.length} 条：\n${lines.join('\n')}` }
          },
        })
        ctx.effect(() => unregisterSearch())
      },
    },
  ]
}
