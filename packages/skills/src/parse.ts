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

/** Markdown frontmatter 切分结果：data = frontmatter 原始字段，body = 正文（已 trim）。 */
export interface FrontmatterSplit {
  data?: Record<string, unknown>
  body?: string
  error?: string
}

/**
 * 按 Agent Skills 规范切分 Markdown：文件必须以 `---` 行开头，在后续某行以 `---` 结束，其后为正文。
 * 只负责「切分 + 解析成对象」，不校验具体字段——校验在 parseSkillMarkdown 里做。
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { error: '缺少 YAML frontmatter：文件必须以 --- 行开头' }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return { error: '缺少 YAML frontmatter 结束行（---）' }
  let raw: unknown
  try {
    raw = parse(lines.slice(1, end).join('\n'))
  } catch (err) {
    return { error: `frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'frontmatter 不是有效对象' }
  return { data: raw as Record<string, unknown>, body: lines.slice(end + 1).join('\n').trim() }
}

/** 取字符串字段：YAML 会把 `version: 1.0` 这类值解析成数字，一并转字符串。 */
function textField(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

/**
 * 解析 Agent Skills 规范的 SKILL.md（YAML frontmatter + Markdown 正文）。
 *
 * - name：取 frontmatter.name；缺失或非法时用 fallbackName（通常是所在目录名）兜底；都没有则报错。
 * - description：必须存在且非空（规范要求），缺失即报错——不自动编造描述。
 * - template：frontmatter 之后的正文（trim），为空即报错。
 * - frontmatter 里的其余字段（license、allowed-tools 等）语义与自有 YAML 不同，一律不映射：
 *   `allowed-tools` 是「预批准工具」，不是本系统的「工具子集限制」，映射过来会用错语义。
 * - 产出的技能带来源标记 source.format='skill-md'（file 留空串——真实文件路径由 FileSkillStore 命中文件时覆盖）：
 *   校验与落盘都要按来源分流，见 validateSkillDefinition / FileSkillStore.add。
 */
export function parseSkillMarkdown(content: string, fallbackName?: string): SkillParseResult {
  const split = splitFrontmatter(content)
  if (!split.data || split.body === undefined) return { error: split.error ?? 'frontmatter 解析失败' }
  const fm = split.data
  const declared = textField(fm.name)?.trim() ?? ''
  const fallback = (fallbackName ?? '').trim()
  let name = declared
  if (!SKILL_NAME_RE.test(name)) {
    if (!SKILL_NAME_RE.test(fallback)) {
      return {
        error: declared
          ? `name "${declared}" 不合法，且未提供合法兜底名（目录名 "${fallback}"）`
          : `缺少合法的 name 字段（frontmatter.name 与目录名 "${fallback}" 均不可用）`,
      }
    }
    name = fallback
  }
  const description = textField(fm.description)?.trim() ?? ''
  if (!description) return { error: '缺少 description 字段（Agent Skills 规范要求必填，不自动编造）' }
  if (!split.body) return { error: '正文为空：frontmatter 之后必须是对应的提示词正文' }
  return {
    skill: normalizeSkillDefinition({
      name,
      description,
      version: textField(fm.version),
      icon: textField(fm.icon),
      category: textField(fm.category),
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
      template: split.body,
      source: { format: 'skill-md', file: '' },
    }),
  }
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

  // 「占位符必须已在 inputs.properties 声明」只对自有 YAML 技能成立：YAML 技能本质是带参数替换的
  // 模板，写了占位符却没声明参数就是作者笔误，值得报错。SKILL.md 来源的技能没有 inputs 概念——
  // Agent Skills 规范里正文就是给模型看的指令文本（渲染器把 {{...}} 当字面量原样输出），
  // 正文出现 {{...}} 是合法内容（例如技能本身就在讲模板语法），不该按模板笔误处理。
  if (skill.source?.format !== 'skill-md' && skill.template && typeof skill.template === 'string') {
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
    // source 是来源元数据，必须随技能一路携带：validateSkillDefinition 按来源决定是否做占位符校验，
    // store 的 add/update/remove 也按来源决定落盘形态与写回目标，归一化时丢掉会让闭环断链。
    source: skill.source,
  }
}
