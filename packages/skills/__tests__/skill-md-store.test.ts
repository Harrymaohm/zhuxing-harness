import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { FileSkillStore } from '../src/file-store.js'
import { parseSkillMarkdown, validateSkillDefinition } from '../src/index.js'
import type { SkillDefinition } from '../src/types.js'

let dir: string
let store: FileSkillStore

const yamlSkill = (): Omit<SkillDefinition, 'createdAt' | 'updatedAt'> => ({
  name: 'code-review',
  version: '0.1.0',
  description: '审查代码差异',
  category: 'dev',
  tags: ['code', 'review'],
  visibility: 'public',
  inputs: {
    type: 'object',
    properties: { diff: { type: 'string', description: '代码差异' } },
    required: ['diff'],
  },
  tools: ['read_file', 'shell'],
  template: '审查以下差异：\n{{diff}}',
})

/** 在 <dir>/<name>/ 下写一份 SKILL.md，返回该文件绝对路径。 */
async function writeSkillMd(name: string, frontmatter: string, body: string): Promise<string> {
  const sub = join(dir, name)
  await mkdir(sub, { recursive: true })
  const file = join(sub, 'SKILL.md')
  await writeFile(file, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8')
  return file
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-skill-md-'))
  store = new FileSkillStore({ dirs: [dir] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('FileSkillStore × Agent Skills 的 SKILL.md', () => {
  it('6. 目录里的 SKILL.md 能被 list 找到，并带 skill-md 来源', async () => {
    const file = await writeSkillMd(
      'pdf-extract',
      'name: pdf-extract\ndescription: 提取 PDF 表格',
      '处理 {{file}}',
    )
    const list = await store.list()
    expect(list.map((s) => s.name)).toEqual(['pdf-extract'])
    expect(list[0].description).toBe('提取 PDF 表格')
    expect(list[0].template).toBe('处理 {{file}}')
    expect(list[0].source).toEqual({ format: 'skill-md', file })
    // get 也要能找到
    expect((await store.get('pdf-extract'))?.source).toEqual({ format: 'skill-md', file })
  })

  it('7. 同名 YAML 与 SKILL.md 并存时 YAML 优先', async () => {
    await writeSkillMd('dup', 'name: dup\ndescription: 外部 SKILL.md', '外部正文')
    const yamlFile = join(dir, 'dup.yaml')
    await writeFile(yamlFile, 'name: dup\ndescription: 本地 YAML\ntemplate: 本地正文\n', 'utf-8')

    const got = await store.get('dup')
    expect(got?.source).toEqual({ format: 'yaml', file: yamlFile })
    expect(got?.description).toBe('本地 YAML')

    const list = await store.list()
    expect(list.length).toBe(1)
    expect(list[0].source?.format).toBe('yaml')
  })

  it('8. remove 对 SKILL.md 生效：只删该文件，保留目录与其它文件', async () => {
    const file = await writeSkillMd('ext', 'name: ext\ndescription: 外部技能', '正文')
    const helper = join(dir, 'ext', 'helper.py')
    await writeFile(helper, 'print(1)\n', 'utf-8')

    expect(await store.remove('ext')).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(dir, 'ext'))).toBe(true)
    expect(existsSync(helper)).toBe(true)
    expect(await store.get('ext')).toBeUndefined()
  })

  it('9. 解析失败的 SKILL.md 不抛错、不静默，其余技能正常返回', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = await writeSkillMd('broken', 'name: broken', '正文') // 缺 description
    await writeSkillMd('good', 'name: good\ndescription: 正常技能', '正文')

    const names = (await store.list()).map((s) => s.name)
    expect(names).toEqual(['good'])
    expect(warn.mock.calls.some((call) => String(call[0]).includes(broken))).toBe(true)
  })

  it('10. 回归：自有 YAML 技能的加载/更新/删除行为不变', async () => {
    const added = await store.add(yamlSkill())
    expect(added.createdAt).toBeTypeOf('number')
    const file = join(dir, 'code-review.yaml')
    expect(existsSync(file)).toBe(true)

    const listed = await store.list()
    expect(listed.map((s) => s.name)).toEqual(['code-review'])
    expect(listed[0].source).toEqual({ format: 'yaml', file })
    expect(listed[0].template).toContain('{{diff}}')

    const updated = await store.update('code-review', { description: '更新后的描述' })
    expect(updated?.description).toBe('更新后的描述')
    expect(updated?.source?.format).toBe('yaml')
    expect(updated?.updatedAt).not.toBe(updated?.createdAt)

    // source 是运行时元数据，不该被写进技能文件本身
    const raw = await readFile(file, 'utf-8')
    expect(raw).not.toContain('source:')
    expect(raw).toContain('更新后的描述')

    expect((await store.get('code-review'))?.description).toBe('更新后的描述')
    expect(await store.remove('code-review')).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(await store.list()).toEqual([])
    expect(await store.remove('code-review')).toBe(false)
  })

  it('11. update 对 SKILL.md 写回原文件：不造影子 yaml，保留非标准 frontmatter 字段', async () => {
    const file = await writeSkillMd(
      'pdf-extract',
      'name: pdf-extract\ndescription: 旧描述\nlicense: MIT\nallowed-tools: ["read_file"]',
      '旧正文',
    )

    const updated = await store.update('pdf-extract', { description: '新描述', template: '新正文' })
    expect(updated?.description).toBe('新描述')
    expect(updated?.source).toEqual({ format: 'skill-md', file })
    // 不应生成同名 yaml 影子技能
    expect(existsSync(join(dir, 'pdf-extract.yaml'))).toBe(false)

    const raw = await readFile(file, 'utf-8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('description: 新描述')
    expect(raw).toContain('新正文')
    // 非标准 frontmatter 字段原样保留
    expect(raw).toContain('license: MIT')
    expect(raw).toContain('allowed-tools')

    const reloaded = await store.get('pdf-extract')
    expect(reloaded?.description).toBe('新描述')
    expect(reloaded?.template).toBe('新正文')
    expect((await store.list()).length).toBe(1)
  })

  it('12. 闭环：SKILL.md（正文含 {{foo}}）落盘 → 读回 → 校验仍无问题', async () => {
    const { skill } = parseSkillMarkdown(
      `---\nname: literal-md\ndescription: 正文里的 {{foo}} 是字面量\n---\n\n用法示例：{{foo}}\n`,
    )
    // 装之前就该是合法技能：否则失败发生在更早一步，这条闭环就测不到了
    expect(skill?.source).toEqual({ format: 'skill-md', file: '' })
    expect(validateSkillDefinition(skill!)).toEqual([])

    const file = join(dir, 'literal-md', 'SKILL.md')
    const added = await store.add(skill!, dir)
    // 按 Agent Skills 规范落盘：不能落成 .yaml，否则来源标记在磁盘上不可辨
    expect(added.source).toEqual({ format: 'skill-md', file })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(dir, 'literal-md.yaml'))).toBe(false)
    expect(await readFile(file, 'utf-8')).toContain('{{foo}}')

    // 读回来的技能必须仍是 skill-md 来源，且校验依旧无问题（否则会「装得上、此后一直显示非法」）
    const reloaded = await store.get('literal-md')
    expect(reloaded?.source).toEqual({ format: 'skill-md', file })
    expect(reloaded?.template).toBe('用法示例：{{foo}}')
    expect(validateSkillDefinition(reloaded!)).toEqual([])
  })

  it('13. SKILL.md 来源的技能 update 仍写回同一份 SKILL.md（不造影子 yaml、不改写文件类型）', async () => {
    const { skill } = parseSkillMarkdown(
      `---\nname: literal-md\ndescription: 旧描述\n---\n\n用法示例：{{foo}}\n`,
    )
    await store.add(skill!, dir)

    const updated = await store.update('literal-md', { description: '新描述' })
    expect(updated?.source).toEqual({ format: 'skill-md', file: join(dir, 'literal-md', 'SKILL.md') })
    expect(existsSync(join(dir, 'literal-md.yaml'))).toBe(false)

    const raw = await readFile(join(dir, 'literal-md', 'SKILL.md'), 'utf-8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('description: 新描述')
    expect(raw).toContain('{{foo}}')

    const reloaded = await store.get('literal-md')
    expect(reloaded?.description).toBe('新描述')
    expect(validateSkillDefinition(reloaded!)).toEqual([])
  })
})
