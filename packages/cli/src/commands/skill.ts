import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { FileSkillStore, buildSkillPrompt } from '@zhuxing/harness-skills'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import { defaultSkillDirs } from '@zhuxing/harness-bundle'
import { out, outError } from '../output.js'

/** 技能管理：list/add/rm/show/run/create。 */
export async function cmdSkill(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const cwd = process.cwd()
  const dirs = defaultSkillDirs(cwd)
  const store = new FileSkillStore({ dirs })
  switch (sub) {
    case 'list': {
      const { values } = parseArgs({
        options: {
          category: { type: 'string', short: 'c' },
          tag: { type: 'string', short: 't' },
          q: { type: 'string' },
        },
        args: rest,
        allowPositionals: false,
      })
      const tags = typeof values.tag === 'string' ? values.tag.split(',').map((t) => t.trim()).filter(Boolean) : undefined
      const skills = await store.list({
        q: values.q,
        category: values.category,
        tags,
      })
      if (skills.length === 0) {
        out('（无技能。harness skill create <名称> 生成模板，或 harness skill add <文件.yaml>）')
        return
      }
      out(`技能目录：${dirs.join(', ')}`)
      for (const s of skills) {
        const icon = s.icon ?? '📌'
        const tagsStr = s.tags?.length ? ` {${s.tags.join(',')}}` : ''
        out(`  ${icon} ${s.name.padEnd(20)} [${s.category ?? 'general'}]${tagsStr}  ${s.description}`)
      }
      break
    }
    case 'add': {
      const file = rest[0]
      if (!file) {
        outError('用法：harness skill add <skill.yaml>')
        process.exitCode = 2
        return
      }
      try {
        const content = await readFile(resolve(cwd, file), 'utf-8')
        const { parse } = await import('yaml')
        const skill = parse(content) as SkillDefinition
        if (!skill.name || !skill.template) {
          outError('技能文件缺少必要字段（name/template）')
          process.exitCode = 2
          return
        }
        const added = await store.add(skill)
        out(`✓ 已安装技能「${added.name}」到 ${dirs[0]}`)
      } catch (err) {
        outError(`安装失败：${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      }
      break
    }
    case 'rm': {
      const name = rest[0]
      if (!name) {
        outError('用法：harness skill rm <名称>')
        process.exitCode = 2
        return
      }
      const ok = await store.remove(name)
      if (ok) out(`✓ 已删除技能「${name}」`)
      else {
        outError(`未找到技能「${name}」`)
        process.exitCode = 1
      }
      break
    }
    case 'show': {
      const name = rest[0]
      if (!name) {
        outError('用法：harness skill show <名称>')
        process.exitCode = 2
        return
      }
      const skill = await store.get(name)
      if (!skill) {
        outError(`未找到技能「${name}」`)
        process.exitCode = 1
        return
      }
      out(JSON.stringify(skill, null, 2))
      break
    }
    case 'run': {
      const { values, positionals } = parseArgs({
        options: { input: { type: 'string', short: 'i' } },
        args: rest,
        allowPositionals: true,
      })
      const name = positionals[0]
      if (!name) {
        outError('用法：harness skill run <名称> --input \'{"diff":"..."}\'')
        process.exitCode = 2
        return
      }
      const skill = await store.get(name)
      if (!skill) {
        outError(`未找到技能「${name}」`)
        process.exitCode = 1
        return
      }
      let inputArgs: Record<string, unknown> = {}
      if (values.input) {
        try {
          inputArgs = JSON.parse(values.input) as Record<string, unknown>
        } catch {
          outError('--input 必须是合法 JSON')
          process.exitCode = 2
          return
        }
      }
      try {
        const prompt = buildSkillPrompt(skill, inputArgs)
        out(prompt)
      } catch (err) {
        outError(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
      break
    }
    case 'create': {
      const name = rest[0]
      if (!name) {
        outError('用法：harness skill create <名称>')
        process.exitCode = 2
        return
      }
      const template: SkillDefinition = {
        name,
        version: '0.1.0',
        description: `${name} 技能`,
        icon: '📌',
        category: 'general',
        tags: [],
        visibility: 'public',
        inputs: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '输入内容' },
          },
          required: ['input'],
        },
        tools: ['read_file', 'shell'],
        template: `你是 ${name} 专家。处理以下输入：\n{{input}}\n\n请给出结构化的结果。`,
      }
      const added = await store.add(template)
      const file = `${dirs[0]}/${name}.yaml`
      out(`✓ 已创建技能模板「${added.name}」→ ${file}`)
      out('  编辑该文件自定义模板/参数/工具子集后即可使用。')
      break
    }
    default:
      outError('用法：harness skill <list|add|rm|show|run|create> [参数]')
      process.exitCode = 2
  }
}
