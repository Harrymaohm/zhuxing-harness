/** 记忆作用域：user=跨项目偏好，project=项目上下文，auto=AI 自动学习，session=对话私有记忆 */
export type MemoryScope = 'user' | 'project' | 'auto' | 'session'

/** 单条记忆条目。 */
export interface MemoryEntry {
  id: string
  scope: MemoryScope
  content: string
  tags?: string[]
  /** project 类型关联的工作区路径。 */
  workspace?: string
  /** session 类型关联的会话 id（对话私有记忆）。 */
  sessionId?: string
  createdAt: number
  updatedAt: number
}

/** 记忆查询过滤条件。 */
export interface MemoryFilter {
  scope?: MemoryScope
  tags?: string[]
  q?: string
  workspace?: string
  /** 仅返回属于该会话的私有记忆。 */
  sessionId?: string
}

/** 记忆存储接口。 */
export interface MemoryStore {
  list(filter?: MemoryFilter): Promise<MemoryEntry[]>
  get(id: string): Promise<MemoryEntry | undefined>
  add(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry>
  update(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry | undefined>
  remove(id: string): Promise<boolean>
  clear(scope?: MemoryScope): Promise<number>
}

/** systemPrompt 记忆增强器：在基础 prompt 上追加相关记忆。 */
export type MemoryPromptEnhancer = (basePrompt: string, userInput: string) => Promise<string>
