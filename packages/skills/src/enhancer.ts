import type { SkillDefinition } from './types.js'

export interface BuildPromptOptions {
  /** 缺失必填参数时是否抛错（默认 true）。 */
  strict?: boolean
}

export class MissingRequiredParameterError extends Error {
  constructor(public readonly missing: string[]) {
    super(`缺少必填参数：${missing.join(', ')}`)
    this.name = 'MissingRequiredParameterError'
  }
}

export function buildSkillPrompt(
  skill: SkillDefinition,
  args: Record<string, unknown>,
  _opts: BuildPromptOptions = {},
): string {
  const required = Array.isArray(skill.inputs?.required) ? (skill.inputs.required as string[]) : []
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
  if (missing.length > 0) {
    throw new MissingRequiredParameterError(missing)
  }
  let out = skill.template
  for (const [k, v] of Object.entries(args)) {
    const placeholder = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g')
    out = out.replace(placeholder, String(v ?? ''))
  }
  return out
}
