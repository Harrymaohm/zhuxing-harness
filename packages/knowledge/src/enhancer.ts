import type { KnowledgePromptEnhancer, KnowledgeRetriever } from './types.js'

/** 知识注入上限（8KB），防止 systemPrompt 膨胀。 */
const MAX_KNOWLEDGE_CHARS = 8192

/** 检索返回的块数。 */
const DEFAULT_TOP_K = 4

/** 构造知识库增强器：根据用户输入检索相关知识块，追加到 systemPrompt。 */
export function buildKnowledgePrompt(
  retriever: KnowledgeRetriever,
  opts: { scope?: 'global' | 'workspace'; workspace?: string; excludeSpecIds?: string[]; topK?: number } = {},
): KnowledgePromptEnhancer {
  return async (basePrompt: string, userInput: string): Promise<string> => {
    try {
      const hits = await retriever.search({
        q: userInput,
        scope: opts.scope,
        workspace: opts.workspace,
        excludeSpecIds: opts.excludeSpecIds,
        topK: opts.topK ?? DEFAULT_TOP_K,
      })
      if (!hits.length) return basePrompt

      const lines: string[] = []
      let total = 0
      for (const h of hits) {
        const line = `- [${h.docTitle}] ${h.text.trim()}`
        if (total + line.length + 1 > MAX_KNOWLEDGE_CHARS) break
        lines.push(line)
        total += line.length + 1
      }
      if (!lines.length) return basePrompt

      const block = `\n\n# Knowledge Base Context\nThe following are relevant excerpts from the user's knowledge base. Use them as authoritative background when answering the current question:\n${lines.join('\n')}`
      return basePrompt + block
    } catch {
      // 检索异常时静默降级，保持正常对话
      return basePrompt
    }
  }
}
