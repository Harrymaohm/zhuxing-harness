/** 基础层插件：沙箱 / 会话 / 工具注册表 / LLM 适配器——其余各域插件的能力来源。 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { createSandbox } from '@zhuxing/harness-sandbox'
import { DefaultSessionService, FileSessionStore, MemorySessionStore } from '@zhuxing/harness-session'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { ChatProvider } from '@zhuxing/harness-llm'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'

/**
 * @param deps.workspace 已 resolve 的绝对工作区路径
 */
export function foundationPlugins(
  deps: Pick<BaseBundleOptions, 'level' | 'workspace' | 'apiKey' | 'baseUrl' | 'model'>,
): PluginDefinition[] {
  return [
    {
      name: 'harness-sandbox',
      description: '权限策略分级沙箱',
      apply(ctx) {
        ctx.provide('sandbox', createSandbox({ level: deps.level, workspace: deps.workspace }))
      },
    },
    {
      name: 'harness-session',
      description: '追加式会话事件日志（config.storeDir 指定时持久化为 JSONL）',
      apply(ctx) {
        const storeDir = ctx.config.storeDir as string | undefined
        const store = storeDir ? new FileSessionStore(storeDir) : new MemorySessionStore()
        ctx.provide('sessionStore', store)
        ctx.provide('sessionService', new DefaultSessionService(store))
      },
    },
    {
      name: 'harness-tools',
      description: '工具注册表（统一执行管道）',
      apply(ctx) {
        ctx.provide('tools', new ToolRegistryImpl())
      },
    },
    {
      name: 'harness-llm',
      description: 'OpenAI 兼容模型适配器（可用 config.provider 注入自定义实现）',
      apply(ctx) {
        const override = ctx.config.provider as ChatProvider | undefined
        ctx.provide(
          'llm',
          override ?? new OpenAICompatibleProvider({ apiKey: deps.apiKey, baseUrl: deps.baseUrl, model: deps.model }),
        )
      },
    },
  ]
}
