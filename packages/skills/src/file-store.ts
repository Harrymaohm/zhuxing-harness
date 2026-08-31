import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { SkillDefinition, SkillStore, SkillFilter } from './types.js'

const SKILL_GLOB = '*.yaml'

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

  private async readYaml<T>(file: string): Promise<T | undefined> {
    try {
      const content = await readFile(file, 'utf-8')
      return parse(content) as T
    } catch {
      return undefined
    }
  }

  private async scanAll(): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = []
    const seen = new Set<string>()
    for (const dir of this.dirs) {
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue
        const file = join(dir, entry)
        const skill = await this.readYaml<SkillDefinition>(file)
        if (skill && skill.name && !seen.has(skill.name)) {
          seen.add(skill.name)
          skills.push(skill)
        }
      }
    }
    return skills
  }

  async list(filter?: SkillFilter): Promise<SkillDefinition[]> {
    const all = await this.scanAll()
    return all.filter((s) => matchFilter(s, filter)).sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(name: string): Promise<SkillDefinition | undefined> {
    for (const dir of this.dirs) {
      for (const ext of ['.yaml', '.yml']) {
        const file = join(dir, `${name}${ext}`)
        const skill = await this.readYaml<SkillDefinition>(file)
        if (skill && skill.name === name) return skill
      }
    }
    return undefined
  }

  async add(input: Omit<SkillDefinition, 'createdAt' | 'updatedAt'>, targetDir?: string): Promise<SkillDefinition> {
    const dir = targetDir ?? this.dirs[0]
    if (!dir) throw new Error('没有可写的技能目录')
    await this.ensureDir(dir)
    const now = Date.now()
    const skill: SkillDefinition = { ...input, createdAt: now, updatedAt: now }
    const file = join(dir, `${input.name}.yaml`)
    await writeFile(file, stringify(skill), 'utf-8')
    return skill
  }

  async update(name: string, patch: Partial<Omit<SkillDefinition, 'name' | 'createdAt'>>): Promise<SkillDefinition | undefined> {
    const existing = await this.get(name)
    if (!existing) return undefined
    const updated: SkillDefinition = { ...existing, ...patch, name: existing.name, createdAt: existing.createdAt, updatedAt: Date.now() }
    const dir = await this.findDir(name)
    if (!dir) return undefined
    const file = join(dir, `${name}.yaml`)
    await writeFile(file, stringify(updated), 'utf-8')
    return updated
  }

  async remove(name: string): Promise<boolean> {
    const dir = await this.findDir(name)
    if (!dir) return false
    for (const ext of ['.yaml', '.yml']) {
      const file = join(dir, `${name}${ext}`)
      try {
        await unlink(file)
        return true
      } catch {
        // try next ext
      }
    }
    return false
  }

  private async findDir(name: string): Promise<string | undefined> {
    for (const dir of this.dirs) {
      for (const ext of ['.yaml', '.yml']) {
        const file = join(dir, `${name}${ext}`)
        try {
          const s = await stat(file)
          if (s.isFile()) return dir
        } catch {
          // not found
        }
      }
    }
    return undefined
  }
}

export { SKILL_GLOB }
