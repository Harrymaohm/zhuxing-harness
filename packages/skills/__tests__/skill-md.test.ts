import { describe, expect, it } from 'vitest'
// 从包入口导入：同时钉住 index.ts 对 parseSkillMarkdown 的对外导出
import { buildSkillPrompt, parseSkillMarkdown, validateSkillDefinition } from '../src/index.js'
import type { SkillDefinition } from '../src/index.js'

/** 拼一份 SKILL.md：YAML frontmatter + 空行 + 正文。 */
function skillMd(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

describe('parseSkillMarkdown（Agent Skills 规范的 SKILL.md）', () => {
  it('1. 解析 frontmatter 与正文', () => {
    const { skill, error } = parseSkillMarkdown(
      skillMd(
        'name: pdf-extract\ndescription: 从 PDF 提取表格\nversion: 0.1.0\ntags:\n  - pdf\n  - extract\nicon: 📄\ncategory: doc',
        '按以下要求处理：\n\n{{input}}',
      ),
    )
    expect(error).toBeUndefined()
    expect(skill?.name).toBe('pdf-extract')
    expect(skill?.description).toBe('从 PDF 提取表格')
    expect(skill?.version).toBe('0.1.0')
    expect(skill?.tags).toEqual(['pdf', 'extract'])
    expect(skill?.icon).toBe('📄')
    expect(skill?.category).toBe('doc')
    expect(skill?.template).toBe('按以下要求处理：\n\n{{input}}')
    // 自有 YAML 的缺省字段仍由 normalizeSkillDefinition 补齐
    expect(skill?.inputs).toEqual({ type: 'object', properties: {}, required: [] })
  })

  it('2. name 缺失/非法时用目录名兜底；兜底名也非法则报错', () => {
    const missing = parseSkillMarkdown(skillMd('description: 提取表格', '正文'), 'pdf-extract')
    expect(missing.skill?.name).toBe('pdf-extract')

    const illegal = parseSkillMarkdown(
      skillMd('name: "pdf extract!"\ndescription: 提取表格', '正文'),
      'pdf-extract',
    )
    expect(illegal.skill?.name).toBe('pdf-extract')

    const bothBad = parseSkillMarkdown(skillMd('description: 提取表格', '正文'), '非法 目录名')
    expect(bothBad.skill).toBeUndefined()
    expect(bothBad.error).toMatch(/name/)

    const noFallback = parseSkillMarkdown(skillMd('description: 提取表格', '正文'))
    expect(noFallback.skill).toBeUndefined()
    expect(noFallback.error).toMatch(/name/)
  })

  it('3. description 缺失/空白 → 报错（不静默给空串）', () => {
    const missing = parseSkillMarkdown(skillMd('name: pdf-extract', '正文'))
    expect(missing.skill).toBeUndefined()
    expect(missing.error).toMatch(/description/)

    const blank = parseSkillMarkdown(skillMd('name: pdf-extract\ndescription: "   "', '正文'))
    expect(blank.skill).toBeUndefined()
    expect(blank.error).toMatch(/description/)
  })

  it('4. 无 frontmatter / 未闭合 / 正文为空 / frontmatter 非法 → 各自报错', () => {
    const noFrontmatter = parseSkillMarkdown('# 提取 PDF\n\nname: pdf-extract')
    expect(noFrontmatter.skill).toBeUndefined()
    expect(noFrontmatter.error).toMatch(/缺少 YAML frontmatter/)

    const unclosed = parseSkillMarkdown('---\nname: pdf-extract\ndescription: 提取表格\n没有结束标记')
    expect(unclosed.skill).toBeUndefined()
    expect(unclosed.error).toMatch(/缺少 YAML frontmatter/)

    const emptyBody = parseSkillMarkdown(skillMd('name: pdf-extract\ndescription: 提取表格', '   '))
    expect(emptyBody.skill).toBeUndefined()
    expect(emptyBody.error).toMatch(/正文/)

    const badYaml = parseSkillMarkdown('---\nname: [未闭合\ndescription: d\n---\n\n正文')
    expect(badYaml.skill).toBeUndefined()
    expect(badYaml.error).toMatch(/frontmatter/)

    const notObject = parseSkillMarkdown('---\n只是一行文本\n---\n\n正文')
    expect(notObject.skill).toBeUndefined()
    expect(notObject.error).toMatch(/frontmatter/)
  })

  it('5. 正文里未传参的 {{foo}} 原样保留（不被清空）', () => {
    const { skill } = parseSkillMarkdown(skillMd('name: note\ndescription: 记笔记', '原样保留 {{foo}} 这个占位符。'))
    expect(skill).toBeDefined()
    const prompt = buildSkillPrompt(skill as SkillDefinition, {})
    expect(prompt).toBe('原样保留 {{foo}} 这个占位符。')
    expect(prompt).toContain('{{foo}}')
  })
})

describe('validateSkillDefinition × 技能来源', () => {
  it('12. 回归：自有 YAML 技能写了未声明的占位符，仍报「占位符未定义」', () => {
    // 这条是底线：来源判断只豁免 SKILL.md，不得把自有 YAML 的检查一起关掉
    const yamlSkill = {
      name: 'tpl-skill',
      description: '自有模板技能',
      inputs: { type: 'object', properties: {}, required: [] },
      template: '处理 {{foo}} 与 {{bar}}',
      source: { format: 'yaml' as const, file: '/tmp/tpl-skill.yaml' },
    }
    const issues = validateSkillDefinition(yamlSkill)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('{{foo}}')
    expect(issues[0]).toContain('{{bar}}')

    // 完全没有 source 的技能（手工构造 / 老数据 / POST /api/skills）走同一套严格校验
    expect(validateSkillDefinition({ ...yamlSkill, source: undefined })).toEqual(issues)
  })

  it('13. SKILL.md 来源：正文是字面量指令文本，出现 {{foo}} 不算模板笔误', () => {
    const { skill } = parseSkillMarkdown(
      skillMd('name: tpl-syntax\ndescription: 讲 {{...}} 模板语法', '用法示例：{{foo}} 会原样保留。'),
    )
    expect(skill?.source).toEqual({ format: 'skill-md', file: '' })
    expect(validateSkillDefinition(skill!)).toEqual([])
  })
})
