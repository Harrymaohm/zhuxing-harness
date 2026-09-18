/** 记忆插件：跨会话记忆服务（remember / recall 工具 + 运行前注入相关记忆）。 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { buildMemoryPrompt, FileMemoryStore, scanMemoryContent } from '@zhuxing/harness-memory'
import type { MemoryScope } from '@zhuxing/harness-memory'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'

/**
 * @param deps.workspace 调用方传入的工作区路径原值（与记忆条目里的 workspace 字段一致，不做 resolve）
 */
export function memoryPlugins(deps: Pick<BaseBundleOptions, 'workspace' | 'memoryPath'>): PluginDefinition[] {
  return [
    {
      name: 'harness-memory',
      description: '跨会话记忆服务（用户偏好 / 项目上下文 / 自动学习），运行前注入相关记忆到 systemPrompt',
      inject: ['tools'],
      apply(ctx) {
        const store = new FileMemoryStore(deps.memoryPath)
        const workspace = deps.workspace
        const enhancer = buildMemoryPrompt(store, workspace)
        ctx.provide('memoryStore', store)
        ctx.provide('memoryPromptEnhancer', enhancer)

        const tools = ctx.inject<ToolRegistry>('tools')
        const unregisterRemember = tools.register({
          name: 'remember',
          description:
            '记住一条事实或偏好，供后续对话使用。参数：content（必填，要记住的内容）、' +
            'scope（user=跨项目偏好 / project=项目上下文 / auto=自动学习 / session=仅当前对话私有，默认 auto）、' +
            'tags（可选，标签数组，如 code-style/tech-stack/decision）。',
          schema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要记住的内容' },
              scope: {
                type: 'string',
                enum: ['user', 'project', 'auto', 'session'],
                description: '记忆作用域（默认 auto；session 仅对当前对话可见）',
              },
              tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
            },
            required: ['content'],
          },
          execute: async (args, ctx) => {
            const content = String(args.content ?? '').trim()
            if (!content) return { error: '缺少 content 参数' }
            const scope = (typeof args.scope === 'string' ? args.scope : 'auto') as MemoryScope
            // 跨会话记忆是「数据不是指令」：指令性内容一旦落库会注入后续会话（持久化注入）。
            const scan = scanMemoryContent(content, scope)
            if (!scan.safe) return { error: scan.reason }
            const entry = await store.add({
              scope,
              content,
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
              workspace: scope === 'project' ? workspace : undefined,
              sessionId: scope === 'session' ? ctx.sessionId : undefined,
            })
            const where = scope === 'session' ? '（当前对话私有）' : ''
            return { text: `已记住 [${entry.scope}]${where}：${content}（id: ${entry.id}）` }
          },
        })
        const unregisterRecall = tools.register({
          name: 'recall',
          description:
            '查询已记住的事实与偏好。参数：q（可选，关键词搜索）、scope（可选，按作用域过滤；session=仅当前对话）。' +
            '无参数时返回全部记忆。',
          schema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: '搜索关键词（匹配内容与标签）' },
              scope: { type: 'string', enum: ['user', 'project', 'auto', 'session'], description: '按作用域过滤' },
            },
          },
          execute: async (args, ctx) => {
            const scope = typeof args.scope === 'string' ? (args.scope as MemoryScope) : undefined
            const entries = await store.list({
              q: typeof args.q === 'string' ? args.q : undefined,
              scope,
              sessionId: scope === 'session' ? ctx.sessionId : undefined,
            })
            if (!entries.length) return { json: entries, text: '无记忆' }
            const lines = entries.map((e) => {
              const tags = e.tags?.length ? ` {${e.tags.join(',')}}` : ''
              return `- [${e.scope}]${tags} ${e.content}`
            })
            return { json: entries, text: `找到 ${entries.length} 条记忆：\n${lines.join('\n')}` }
          },
        })
        ctx.effect(() => {
          unregisterRemember()
          unregisterRecall()
        })
      },
    },
  ]
}
