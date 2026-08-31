import { parse } from 'yaml'
import type { SkillDefinition } from './types.js'

/** 技能名：以字母/数字开头，可含字母、数字、_、-。 */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface SkillParseResult {
  skill?: SkillDefinition
  error?: string
}

/** 解析单个技能文本（YAML / JSON，JSON 是 YAML 子集）。 */
export function parseSkill(content: string): SkillParseResult {
  let raw: unknown
  try {
    raw = parse(content)
  } catch (err) {
    return { error: `YAML/JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '内容不是有效对象' }
  const skill = raw as Partial<SkillDefinition>
  if (!skill.name || typeof skill.name !== 'string') return { error: '缺少 name 字段' }
  if (!skill.template || typeof skill.template !== 'string') return { error: '缺少 template 字段' }
  return { skill: raw as SkillDefinition }
}

/** 校验技能定义规范性，返回问题列表（空数组=通过）。 */
export function validateSkillDefinition(skill: Partial<SkillDefinition>): string[] {
  const issues: string[] = []
  if (!skill.name || typeof skill.name !== 'string') {
    issues.push('缺少 name')
  } else if (!SKILL_NAME_RE.test(skill.name)) {
    issues.push(`name "${skill.name}" 只能含字母数字与 _-，且以字母/数字开头`)
  }
  if (!skill.description || !String(skill.description).trim()) issues.push('缺少 description')
  if (!skill.template || !String(skill.template).trim()) issues.push('缺少 template')

  const inputs = (skill.inputs ?? {}) as Record<string, unknown>
  const props = (inputs.properties ?? {}) as Record<string, unknown>
  const required = Array.isArray(inputs.required) ? (inputs.required as string[]) : []
  if (required.some((k) => !(k in props))) issues.push('inputs.required 中的字段未在 properties 中定义')

  if (skill.template && typeof skill.template === 'string') {
    const placeholders = [...String(skill.template).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1])
    if (placeholders.length) {
      const unknown = [...new Set(placeholders.filter((ph) => !(ph in props)))]
      if (unknown.length) issues.push(`模板占位符 ${unknown.map((p) => `{{${p}}}`).join(' ')} 未在 inputs.properties 中定义`)
    }
  }
  if (skill.tools && !Array.isArray(skill.tools)) issues.push('tools 须为字符串数组')
  if (skill.tags && !Array.isArray(skill.tags)) issues.push('tags 须为数组')
  return issues
}

/** 归一化：补齐缺省字段，产出完整合法的 SkillDefinition。 */
export function normalizeSkillDefinition(skill: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: skill.name as string,
    version: skill.version,
    description: skill.description ?? '',
    icon: skill.icon,
    category: skill.category,
    tags: Array.isArray(skill.tags) ? skill.tags.map(String) : undefined,
    visibility: skill.visibility === 'private' ? 'private' : 'public',
    inputs: skill.inputs ?? { type: 'object', properties: {}, required: [] },
    tools: Array.isArray(skill.tools) ? skill.tools.map(String) : undefined,
    memory: skill.memory,
    template: skill.template ?? '',
  }
}
