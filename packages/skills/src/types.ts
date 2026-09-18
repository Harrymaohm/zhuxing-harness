import type { MemoryScope } from '@zhuxing/harness-memory'

/** 技能定义：可复用的提示词模板 + 输入参数 + 可选工具子集 + 记忆绑定。 */
export interface SkillDefinition {
  name: string
  version?: string
  description: string
  icon?: string
  category?: string
  tags?: string[]
  visibility?: 'public' | 'private'
  /** 输入参数 JSON Schema。 */
  inputs: Record<string, unknown>
  /** 可选：仅启用指定工具子集（缺省=全部工具）。 */
  tools?: string[]
  /** 可选：记忆绑定（运行时注入相关记忆）。 */
  memory?: { scope: MemoryScope; tags?: string[] }
  /** 提示词模板，含 {{param}} 占位符。 */
  template: string
  /**
   * 技能来源：自有 YAML 模板，或外部 Agent Skills 规范的 SKILL.md（只读生态）。
   * 必须区分：update() 要按来源写回对应文件，remove() 要按来源删对应文件，
   * 否则会对 SKILL.md 技能静默删不掉、或在 update() 时造出同名 yaml 影子技能互相遮蔽。
   */
  source?: { format: 'yaml' | 'skill-md'; file: string }
  createdAt?: number
  updatedAt?: number
}

/** 技能查询过滤条件。 */
export interface SkillFilter {
  q?: string
  category?: string
  tags?: string[]
}

/** 技能存储接口（CRUD）。 */
export interface SkillStore {
  list(filter?: SkillFilter): Promise<SkillDefinition[]>
  get(name: string): Promise<SkillDefinition | undefined>
  /** 添加技能。targetDir 可选：写入指定目录（默认写入首个可写目录，通常为全局）。 */
  add(input: Omit<SkillDefinition, 'createdAt' | 'updatedAt'>, targetDir?: string): Promise<SkillDefinition>
  update(name: string, patch: Partial<Omit<SkillDefinition, 'name' | 'createdAt'>>): Promise<SkillDefinition | undefined>
  remove(name: string): Promise<boolean>
}

/** 技能运行结果。 */
export interface SkillRunResult {
  prompt: string
  tools?: string[]
}

/** 技能注册表（运行时注册 + 执行）。 */
export interface SkillRegistry {
  register(skill: SkillDefinition): () => void
  get(name: string): SkillDefinition | undefined
  list(): SkillDefinition[]
  run(name: string, args: Record<string, unknown>): Promise<SkillRunResult>
}
