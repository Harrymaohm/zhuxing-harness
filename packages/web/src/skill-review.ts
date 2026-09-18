import AdmZip from 'adm-zip'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import {
  normalizeSkillDefinition,
  parseSkill,
  parseSkillMarkdown,
  validateSkillDefinition,
} from '@zhuxing/harness-skills'
import { defaultSkillDirs } from '@zhuxing/harness-bundle'
import type { WebConfig } from './config-store.js'
import type { RuntimeManager } from './runtime.js'

// ============ 技能上传 / 审核 / 安装 ============

/** 上传文件中解析出的技能候选。 */
export interface SkillCandidate {
  sourceFile: string
  skill: SkillDefinition | null
  issues: string[]
  review: {
    status: 'approve' | 'reject' | 'needs_fix' | 'skipped'
    feedback: string
  }
}

/** Agent Skills 规范的技能入口文件名（规范定死大写，与 FileSkillStore 的扫描规则保持一致）。 */
const SKILL_MD = 'SKILL.md'

/** 待解析文本的来源：自有 YAML / Agent Skills 规范的 SKILL.md。 */
type SkillTextKind = 'yaml' | 'skill-md'

/** 一份待解析的技能文本（单文件上传，或 zip 内的一个条目）。 */
interface SkillText {
  /** 候选展示名：单文件用上传文件名，zip 内用包内相对路径。 */
  name: string
  content: string
  kind: SkillTextKind
  /** SKILL.md 的兜底技能名：zip 内取所在目录名，单文件取文件名去扩展名。 */
  fallbackName?: string
}

function isYamlFile(name: string): boolean {
  return /\.(ya?ml)$/i.test(name)
}

function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name)
}

/** zip 条目是否 Agent Skills 的打包形态：`<任意层级目录>/SKILL.md`（也含直接放在根目录的）。 */
function isSkillMdEntry(entryName: string): boolean {
  return (entryName.split('/').pop() ?? entryName) === SKILL_MD
}

/** zip 内 SKILL.md 的兜底名=所在目录名（`a/b/SKILL.md` → `b`）；直接放在包根目录时无兜底名，需 frontmatter 自带 name。 */
function entryFallbackName(entryName: string): string | undefined {
  const parts = entryName.split('/').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : undefined
}

function fileToText(buffer: Buffer): string {
  try {
    return buffer.toString('utf-8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

/**
 * 单文件上传转待解析文本：`.yaml/.yml` 走自有格式，`.md` 按 Agent Skills 规范解析。
 * 兜底名取「上传文件名去扩展名」——文件名 `SKILL.md` 本身不能当技能名（含 `.`，且无目录上下文可借）。
 */
function singleFileToText(name: string, buffer: Buffer): SkillText | undefined {
  if (isYamlFile(name)) return { name, content: fileToText(buffer), kind: 'yaml' }
  if (isMarkdownFile(name)) {
    const base = name.split(/[\\/]/).pop() ?? name
    return { name, content: fileToText(buffer), kind: 'skill-md', fallbackName: base.replace(/\.md$/i, '') }
  }
  return undefined
}

/** 从 .zip 字节中提取全部技能文本：自有 `*.yaml|*.yml` + Agent Skills 的 `<技能名>/SKILL.md`（一个包里可能含多个技能）。 */
function extractSkillTextsFromZip(buffer: Buffer): SkillText[] {
  const zip = new AdmZip(buffer)
  const outputs: SkillText[] = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const content = fileToText(entry.getData())
    if (isYamlFile(entry.entryName)) {
      outputs.push({ name: entry.entryName, content, kind: 'yaml' })
    } else if (isSkillMdEntry(entry.entryName)) {
      outputs.push({
        name: entry.entryName,
        content,
        kind: 'skill-md',
        fallbackName: entryFallbackName(entry.entryName),
      })
    }
  }
  return outputs
}

/** 按来源解析技能文本：SKILL.md 走 Agent Skills 规范（frontmatter + 正文），其余走自有 YAML/JSON（相对宽松：仅要求可解析为对象）。 */
function parseSkillText(text: SkillText): { skill?: SkillDefinition; error?: string } {
  return text.kind === 'skill-md'
    ? parseSkillMarkdown(text.content, text.fallbackName)
    : parseSkill(text.content)
}

/** 将一组上传文件（单文件 .yaml/.yml/.md，或 zip 批量）解析为技能候选列表。 */
export function buildSkillCandidates(
  files: Array<{ name?: string; dataBase64?: string }>,
): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = []
  for (const file of files) {
    if (!file?.dataBase64) continue
    const rawName = file.name || 'skill.yaml'
    const buffer = Buffer.from(file.dataBase64, 'base64')
    let texts: SkillText[]
    if (isYamlFile(rawName) || isMarkdownFile(rawName)) {
      const single = singleFileToText(rawName, buffer)
      texts = single ? [single] : []
    } else if (/\.(zip)$/i.test(rawName)) {
      try {
        texts = extractSkillTextsFromZip(buffer)
      } catch (err) {
        candidates.push({
          sourceFile: rawName,
          skill: null,
          issues: [`解压 zip 失败：${err instanceof Error ? err.message : String(err)}`],
          review: { status: 'reject', feedback: '压缩包无法解压' },
        })
        continue
      }
    } else {
      candidates.push({
        sourceFile: rawName,
        skill: null,
        issues: ['仅支持 .yaml/.yml、SKILL.md 或 .zip 文件'],
        review: { status: 'reject', feedback: '不支持的格式' },
      })
      continue
    }
    if (texts.length === 0) {
      candidates.push({
        sourceFile: rawName,
        skill: null,
        issues: ['未在压缩包中找到 .yaml/.yml 或 SKILL.md 技能定义文件'],
        review: { status: 'reject', feedback: '压缩包内没有技能定义文件' },
      })
      continue
    }
    for (const text of texts) {
      const { skill, error } = parseSkillText(text)
      if (!skill) {
        candidates.push({
          sourceFile: text.name,
          skill: null,
          issues: [error ?? '解析失败'],
          review: { status: 'reject', feedback: '无法解析为技能定义' },
        })
        continue
      }
      candidates.push({
        sourceFile: text.name,
        skill: normalizeSkillDefinition(skill),
        issues: validateSkillDefinition(skill),
        review: { status: 'skipped', feedback: '' },
      })
    }
  }
  return Promise.resolve(candidates)
}

/** 调用 AI 对单个技能候选做审核/规整，返回审核结论并更新候选。 */
export async function reviewSkillCandidate(candidate: SkillCandidate, cfg: WebConfig): Promise<SkillCandidate> {
  const apiKey = cfg.apiKey
  const model = cfg.model
  if (!apiKey || !model) {
    return { ...candidate, review: { status: 'skipped', feedback: '未配置模型，已跳过 AI 审核' } }
  }
  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
    model,
  })
  const prompt = [
    '你是一个技能（Skill）审核员。技能是一段可复用的提示词模板，需符合以下结构：',
    '字段：name(必填,字母数字与 _-)、version、description(必填)、icon、category、tags、visibility(public/private)、inputs(JSON Schema)、tools(字符串数组)、memory、template(必填,含 {{param}} 占位符)。',
    '请检查候选技能定义，找出：1) 字段缺失/类型错误；2) name 非法；3) template 占位符与 inputs.properties 不匹配；4) 描述/提示词质量问题。',
    '若可修复则修复并返回 status=approve，并给出修复后的完整 JSON；无法修复返回 reject；小问题返回 needs_fix。',
    '严格按如下 JSON 输出（不要用代码块包裹，不要附加解释）：',
    '{"status":"approve"|"reject"|"needs_fix","feedback":"简短中文说明","issues":["..."],"skill":{完整技能定义JSON}}',
    '',
    '待审核技能定义：',
    JSON.stringify(candidate.skill, null, 2),
  ].join('\n')

  try {
    const result = await provider.chat([
      { role: 'system', content: '你是严谨的技能审核员，只输出 JSON。' },
      { role: 'user', content: prompt },
    ])
    const text = (result.content ?? '').trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(text) as { status?: string; feedback?: string; issues?: string[]; skill?: SkillDefinition }
    const status = parsed.status === 'approve' ? 'approve' : parsed.status === 'reject' ? 'reject' : parsed.status === 'needs_fix' ? 'needs_fix' : 'skipped'
    let skill = candidate.skill
    if (parsed.skill && typeof parsed.skill === 'object') {
      // 来源元数据不由审核结果决定：审核 prompt 里没有 source 这个字段，模型通常不会回传它，
      // 一旦丢掉，SKILL.md 来源的技能在安装校验时会被当成自有 YAML 模板而误报「占位符未定义」。
      skill = normalizeSkillDefinition({ ...parsed.skill, source: candidate.skill?.source })
    }
    return {
      sourceFile: candidate.sourceFile,
      skill,
      issues: validateSkillDefinition(skill ?? {}),
      review: { status, feedback: parsed.feedback ?? '' },
    }
  } catch (err) {
    return {
      ...candidate,
      review: { status: 'skipped', feedback: `AI 审核失败，已跳过：${err instanceof Error ? err.message : String(err)}` },
    }
  }
}

/** 根据安装范围解析实际目录。 */
export function resolveSkillTargetDir(runtime: RuntimeManager, scope: string): string | undefined {
  if (scope === 'global') return defaultSkillDirs(runtime.workspacePath)[0]
  if (scope === 'project') return defaultSkillDirs(runtime.workspacePath)[1]
  if (scope && typeof scope === 'string') return scope
  return undefined
}
