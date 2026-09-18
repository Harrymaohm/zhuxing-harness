import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { SkillDefinition, SkillStore, SkillFilter } from './types.js'
import { parseSkillMarkdown, splitFrontmatter } from './parse.js'

const SKILL_GLOB = '*.yaml'
/** Agent Skills 规范的技能入口文件名（规范定死大写）。 */
const SKILL_MD = 'SKILL.md'
/** SKILL.md 里由本系统管理的 frontmatter 键，其余键原样保留。 */
const MANAGED_FM_KEYS = ['name', 'description', 'version', 'icon', 'category', 'tags'] as const

function matchFilter(skill: SkillDefinition, filter?: SkillFilter): boolean {
  if (!filter) return true
  if (filter.category && skill.category !== filter.category) return false
  if (filter.tags?.length && (!skill.tags || !filter.tags.every((t) => skill.tags!.includes(t)))) return false
  if (filter.q) {
    const q = filter.q.toLowerCase()
    const hay = `${skill.name} ${skill.description} ${skill.tags?.join(' ') ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

/** 落盘前去掉 source 来源元数据：它是运行时定位信息，不该被写进技能文件本身。 */
function withoutSource(skill: SkillDefinition): Record<string, unknown> {
  const persisted: Record<string, unknown> = { ...skill }
  delete persisted.source
  return persisted
}

/** 目录/文件「不存在」属正常情况（没有 SKILL.md 的普通目录），不算异常需要告警。 */
function isMissingPath(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export interface FileSkillStoreOptions {
  dirs: string[]
}

export class FileSkillStore implements SkillStore {
  private dirs: string[]
  constructor(opts: FileSkillStoreOptions) {
    this.dirs = opts.dirs
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  private async readEntries(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch {
      // 目录不存在或不可读 = 该目录暂无技能
      return []
    }
  }

  /**
   * 读取并解析自有 YAML 技能文件。
   * 文件不存在返回 undefined（正常）；文件存在但解析失败/结构不对则告警，不静默跳过。
   * 注意：`get()` 复用扫描结果，不会对缺失文件调用到这里。
   */
  private async readYamlSkill(file: string): Promise<SkillDefinition | undefined> {
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch {
      // 候选路径不存在：正常情况（逐个尝试 .yaml/.yml 时必然出现）
      return undefined
    }
    let raw: unknown
    try {
      raw = parse(content)
    } catch (err) {
      console.warn(
        `[harness] 技能文件解析失败，已跳过：${file} —— ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(`[harness] 技能文件内容不是有效对象，已跳过：${file}`)
      return undefined
    }
    const skill = raw as Partial<SkillDefinition>
    if (!skill.name || typeof skill.name !== 'string') {
      console.warn(`[harness] 技能文件缺少 name 字段，已跳过：${file}`)
      return undefined
    }
    return { ...(raw as SkillDefinition), source: { format: 'yaml', file } }
  }

  /** 读取并解析 `<dir>/<entry>/SKILL.md`（Agent Skills 规范）。 */
  private async readSkillMd(dir: string, entry: string): Promise<SkillDefinition | undefined> {
    const file = join(dir, entry, SKILL_MD)
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch (err) {
      if (!isMissingPath(err)) {
        console.warn(
          `[harness] SKILL.md 读取失败，已跳过：${file} —— ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return undefined
    }
    const { skill, error } = parseSkillMarkdown(content, entry)
    if (!skill) {
      console.warn(`[harness] SKILL.md 解析失败，已跳过：${file} —— ${error}`)
      return undefined
    }
    return { ...skill, source: { format: 'skill-md', file } }
  }

  /**
   * 扫描全部目录：自有 `*.yaml|*.yml` + Agent Skills 的 `<名称>/SKILL.md`。
   * 两趟扫描 + 先到先得去重，因此**自有 YAML 优先于 SKILL.md**（本地可覆盖外部生态技能）。
   */
  private async scanAll(): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = []
    const seen = new Set<string>()
    const push = (skill: SkillDefinition | undefined): void => {
      if (!skill || seen.has(skill.name)) return
      seen.add(skill.name)
      skills.push(skill)
    }
    for (const dir of this.dirs) {
      for (const entry of await this.readEntries(dir)) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue
        push(await this.readYamlSkill(join(dir, entry)))
      }
    }
    for (const dir of this.dirs) {
      for (const entry of await this.readEntries(dir)) {
        push(await this.readSkillMd(dir, entry))
      }
    }
    return skills
  }

  async list(filter?: SkillFilter): Promise<SkillDefinition[]> {
    const all = await this.scanAll()
    return all.filter((s) => matchFilter(s, filter)).sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    // 复用扫描结果而不是单独按文件名定位：保证 get 与 list 看到的技能完全一致（含 YAML 优先与去重）
    const all = await this.scanAll()
    return all.find((s) => s.name === name)
  }

  /**
   * 添加技能。落盘形态按来源分流：SKILL.md 来源按 Agent Skills 规范写 `<目录>/<名称>/SKILL.md`，
   * 其余写自有技能文件 `<目录>/<名称>.yaml`。
   *
   * 为什么 SKILL.md 来源不能落成 .yaml：两者不是同一种东西——YAML 技能是「模板 + 参数替换」，
   * 正文里的 {{...}} 必须已在 inputs.properties 声明；SKILL.md 的正文是字面量指令文本，
   * 含 {{...}} 是合法内容。落成 .yaml 会让来源标记在磁盘上丢失，读回时被判成
   * 「占位符未定义」的非法技能（装得上、此后一直显示非法）；反过来把标记塞进 .yaml，
   * 会让 source.format 同时承担「存储容器」与「来源语义」两义，update() 便会按 skill-md
   * 分支把一个 .yaml 文件改写成 frontmatter 文档——直接损坏技能。
   */
  async add(input: Omit<SkillDefinition, 'createdAt' | 'updatedAt'>, targetDir?: string): Promise<SkillDefinition> {
    const dir = targetDir ?? this.dirs[0]
    if (!dir) throw new Error('没有可写的技能目录')
    await this.ensureDir(dir)
    const now = Date.now()
    const skill: SkillDefinition = { ...input, createdAt: now, updatedAt: now }
    if (input.source?.format === 'skill-md') {
      const sub = join(dir, input.name)
      await this.ensureDir(sub)
      const file = join(sub, SKILL_MD)
      await this.writeSkillMd(file, skill)
      return { ...skill, source: { format: 'skill-md', file } }
    }
    const file = join(dir, `${input.name}.yaml`)
    await writeFile(file, stringify(withoutSource(skill)), 'utf-8')
    return { ...skill, source: { format: 'yaml', file } }
  }

  async update(name: string, patch: Partial<Omit<SkillDefinition, 'name' | 'createdAt'>>): Promise<SkillDefinition | undefined> {
    const existing = await this.get(name)
    if (!existing?.source) return undefined
    const updated: SkillDefinition = {
      ...existing,
      ...patch,
      name: existing.name,
      createdAt: existing.createdAt,
      source: existing.source,
      updatedAt: Date.now(),
    }
    if (existing.source.format === 'skill-md') {
      await this.writeSkillMd(existing.source.file, updated)
    } else {
      // 写回原文件（可能是 .yml）：按文件名另写一份会留下同名影子技能互相遮蔽
      await writeFile(existing.source.file, stringify(withoutSource(updated)), 'utf-8')
    }
    return updated
  }

  /**
   * 写回 SKILL.md：重新生成 frontmatter 中的标准字段（name/description/version/icon/category/tags），
   * **其余字段原样保留**（license、allowed-tools、作者自加键等），正文替换为当前 template。
   * 本系统自有语义里没有标准位置的字段（inputs/tools/memory/visibility）不会被写入。
   */
  private async writeSkillMd(file: string, skill: SkillDefinition): Promise<void> {
    let frontmatter: Record<string, unknown> = {}
    try {
      const split = splitFrontmatter(await readFile(file, 'utf-8'))
      if (split.data) frontmatter = { ...split.data }
    } catch {
      // 原文件已被外部删除/不可读：按全新 frontmatter 写入
    }
    for (const key of MANAGED_FM_KEYS) delete frontmatter[key]
    frontmatter.name = skill.name
    frontmatter.description = skill.description
    if (skill.version) frontmatter.version = skill.version
    if (skill.icon) frontmatter.icon = skill.icon
    if (skill.category) frontmatter.category = skill.category
    if (skill.tags?.length) frontmatter.tags = skill.tags
    // yaml.stringify 已自带结尾换行，正文与 frontmatter 之间留一个空行
    await writeFile(file, `---\n${stringify(frontmatter)}---\n\n${skill.template}\n`, 'utf-8')
  }

  async remove(name: string): Promise<boolean> {
    const skill = await this.get(name)
    const file = skill?.source?.file
    if (!file) return false
    try {
      // SKILL.md 只删该文件本身，目录里可能还有技能自带的 scripts / references 等资源
      await unlink(file)
      return true
    } catch {
      // 文件已被外部删除或不可写
      return false
    }
  }
}

export { SKILL_GLOB }
