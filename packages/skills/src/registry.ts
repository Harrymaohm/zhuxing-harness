import type { SkillDefinition, SkillRegistry, SkillRunResult } from './types.js'
import { buildSkillPrompt } from './enhancer.js'

export class SkillRegistryImpl implements SkillRegistry {
  private skills = new Map<string, SkillDefinition>()

  register(skill: SkillDefinition): () => void {
    this.skills.set(skill.name, skill)
    return () => {
      if (this.skills.get(skill.name) === skill) {
        this.skills.delete(skill.name)
      }
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  async run(name: string, args: Record<string, unknown>): Promise<SkillRunResult> {
    const skill = this.skills.get(name)
    if (!skill) throw new Error(`技能未找到：${name}`)
    const prompt = buildSkillPrompt(skill, args)
    return { prompt, tools: skill.tools }
  }
}
