import type { MemoryEntry, MemoryPromptEnhancer, MemoryStore } from './types.js'

/** 记忆注入上限（4KB），防止 systemPrompt 膨胀。 */
const MAX_MEMORY_CHARS = 4096

const SCOPE_ORDER: Record<string, number> = { user: 0, project: 1, auto: 2, session: 3 }

function formatEntry(e: MemoryEntry): string {
  const tags = e.tags?.length ? ` {${e.tags.join(',')}}` : ''
  return `- [${e.scope}]${tags} ${e.content}`
}

/**
 * 构造全局记忆增强的 systemPrompt：在基础 prompt 后追加跨会话记忆（不替换）。
 * 只纳入 user / project / auto（排除 session 对话私有记忆），按 scope 优先级排序，总计截断 4KB。
 */
export function buildMemoryPrompt(
  store: MemoryStore,
  workspace?: string,
): MemoryPromptEnhancer {
  return async (basePrompt: string, _userInput: string): Promise<string> => {
    const entries = (await store.list()).filter((e) => e.scope !== 'session')
    if (entries.length === 0) return basePrompt

    const sorted = [...entries].sort((a, b) => {
      const sa = SCOPE_ORDER[a.scope] ?? 9
      const sb = SCOPE_ORDER[b.scope] ?? 9
      if (sa !== sb) return sa - sb
      return b.updatedAt - a.updatedAt
    })

    // project 类型按 workspace 过滤（无 workspace 字段的全局 project 记忆保留）
    const relevant = workspace
      ? sorted.filter((e) => e.scope !== 'project' || !e.workspace || e.workspace === workspace)
      : sorted

    if (relevant.length === 0) return basePrompt

    const lines: string[] = []
    let total = 0
    for (const e of relevant) {
      const line = formatEntry(e)
      if (total + line.length + 1 > MAX_MEMORY_CHARS) break
      lines.push(line)
      total += line.length + 1
    }

    if (lines.length === 0) return basePrompt

    const memoryBlock = `\n\n# Memory\nThe following are remembered facts and preferences about the user and project:\n${lines.join('\n')}`
    return basePrompt + memoryBlock
  }
}

/**
 * 构造「对话私有记忆」增强器：只纳入属于指定会话的记录（scope === 'session' 且 sessionId 匹配）。
 * 用于把某个历史对话自己的记忆摘要注入到本次发送。
 */
export function buildSessionMemoryPrompt(store: MemoryStore, sessionId: string): MemoryPromptEnhancer {
  return async (basePrompt: string, _userInput: string): Promise<string> => {
    const entries = (await store.list()).filter((e) => e.scope === 'session' && e.sessionId === sessionId)
    if (entries.length === 0) return basePrompt

    const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)

    const lines: string[] = []
    let total = 0
    for (const e of sorted) {
      const line = formatEntry(e)
      if (total + line.length + 1 > MAX_MEMORY_CHARS) break
      lines.push(line)
      total += line.length + 1
    }

    if (lines.length === 0) return basePrompt

    const memoryBlock = `\n\n# Referenced Conversation Memory\nThe following are facts remembered within this referenced conversation:\n${lines.join('\n')}`
    return basePrompt + memoryBlock
  }
}
