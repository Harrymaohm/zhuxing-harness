/** 技能插件：提示词模板 + 输入参数 + 工具子集的可复用经验包（use_skill / list_skills 工具）。 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { FileSkillStore, SkillRegistryImpl } from '@zhuxing/harness-skills'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'

/** 默认技能搜索目录：全局（~/.zhuxing-harness/skills/）+ 项目级（工作区/.harness/skills/）。 */
export function defaultSkillDirs(workspace?: string): string[] {
  const dirs = [join(homedir(), '.zhuxing-harness', 'skills')]
  if (workspace) dirs.push(join(resolve(workspace), '.harness', 'skills'))
  return dirs
}

/**
 * @param deps.workspace 调用方传入的工作区路径原值（用于推导默认技能目录，不做 resolve）
 */
export function skillsPlugins(deps: Pick<BaseBundleOptions, 'workspace' | 'skillsDirs'>): PluginDefinition[] {
  return [
    {
      name: 'harness-skill-loader',
      description: '技能系统：提示词模板 + 输入参数 + 工具子集，可复用可分享的经验包（注册 use_skill 工具）',
      inject: ['tools'],
      apply(ctx) {
        const dirs = deps.skillsDirs ?? defaultSkillDirs(deps.workspace)
        const store = new FileSkillStore({ dirs })
        const registry = new SkillRegistryImpl()
        // 启动时从文件存储加载全部技能到运行时注册表
        void store
          .list()
          .then((skills) => {
            for (const skill of skills) registry.register(skill)
          })
          // 技能目录读取失败只影响技能可用性，不该以 unhandledRejection 的形式拖垮整个启动
          .catch((err: unknown) => {
            ctx.logger.error('技能目录加载失败，本次启动未注册任何技能', err)
          })
        ctx.provide('skillStore', store)
        ctx.provide('skillRegistry', registry)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterUseSkill = tools.register({
          name: 'use_skill',
          description:
            '调用一个已安装的技能（可复用的提示词模板）。参数：skill（必填，技能名）、' +
            'args（必填，技能输入参数对象，需匹配技能 inputs schema）。返回渲染后的提示词。',
          schema: {
            type: 'object',
            properties: {
              skill: { type: 'string', description: '技能名（可通过 list_skills 查看）' },
              args: { type: 'object', description: '技能输入参数' },
            },
            required: ['skill', 'args'],
          },
          execute: async (args) => {
            const skillName = String(args.skill ?? '')
            const skillArgs = (args.args as Record<string, unknown>) ?? {}
            try {
              const result = await registry.run(skillName, skillArgs)
              return {
                text: `技能「${skillName}」已渲染，请按以下提示词执行：\n\n${result.prompt}${
                  result.tools ? `\n\n（建议启用的工具子集：${result.tools.join(', ')}）` : ''
                }`,
              }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        const unregisterListSkills = tools.register({
          name: 'list_skills',
          description: '列出当前已安装的所有技能（名称、描述、图标、分类、标签），供决策使用。',
          schema: { type: 'object', properties: {}, required: [] },
          execute: async () => {
            const list = registry.list().map((s) => ({
              name: s.name,
              description: s.description,
              icon: s.icon,
              category: s.category,
              tags: s.tags,
            }))
            return { json: list, text: `共 ${list.length} 个技能` }
          },
        })
        ctx.effect(() => {
          unregisterUseSkill()
          unregisterListSkills()
        })
      },
    },
  ]
}
