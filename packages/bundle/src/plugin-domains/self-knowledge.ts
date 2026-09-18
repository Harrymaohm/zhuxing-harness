/** 本体自省插件：注册 harness_help 工具，按需返回本软件的命令 / 端点 / 路径 / 插件 / 工具 / 内置流程。 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'
import { renderSelfKnowledge, summarizePluginPermissions, SELF_KNOWLEDGE_TOPICS } from '../self-knowledge.js'

/**
 * @param deps.workspace 已 resolve 的绝对工作区路径（用于渲染本体知识）
 */
export function selfKnowledgePlugins(deps: Pick<BaseBundleOptions, 'workspace'>): PluginDefinition[] {
  return [
    {
      name: 'harness-self-knowledge',
      description: '本体自省（辅助程序）：按需返回本软件的命令 / 端点 / 路径 / 插件 / 工具 / 内置流程，提示词不再常驻这些知识',
      inject: ['tools'],
      apply(ctx) {
        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterHelp = tools.register({
          name: 'harness_help',
          description:
            '查询本软件（筑星 Harness）自身的知识：版本与运行形态、配置与数据路径、CLI 命令、Web API 端点、' +
            '已装插件、可用工具、内置流程（含内核自更新）。涉及本软件自身的运行、配置、更新或扩展时，' +
            '先取对应话题再动手，不要凭记忆猜测。',
          schema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                enum: SELF_KNOWLEDGE_TOPICS,
                description:
                  '话题：overview 总览（默认）/ commands CLI 命令 / api Web API 端点 / paths 配置与数据路径 / ' +
                  'plugins 已装插件 / tools 可用工具 / flows 内置流程（如内核自更新）',
              },
            },
          },
          execute: async (args) => {
            const records = ctx.app.pluginManager.list()
            return {
              text: renderSelfKnowledge(String(args.topic ?? 'overview'), {
                workspace: deps.workspace,
                plugins: records.map((r) => ({
                  id: r.id,
                  description: r.definition.description,
                  enabled: r.state === 'mounted',
                  permissions: summarizePluginPermissions(r.definition.permissions),
                })),
                tools: tools.list().map((t) => ({ name: t.name, description: t.description })),
              }),
            }
          },
        })
        ctx.effect(unregisterHelp)
      },
    },
  ]
}
