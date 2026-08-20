import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = 'hello-plugin'
export const version = '0.1.0'
export const description = '示例插件：注册一个问候工具'

export const inject = ['tools']

export function apply(ctx: Context) {
  const tools = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools')

  // 通过 SDK 的 defineTool 注册一个工具（能力即插件）
  const unregisterHello = tools.register(
    defineTool({
      name: 'hello',
      description: '向用户问候，并返回当前时间',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (args) => ({
        text: `你好，${args.name ?? '朋友'}！当前时间是 ${new Date().toISOString()}`,
      }),
    }),
  )

  // 可逆副作用：插件卸载时自动注销工具并清理（热重载/卸载零残留）
  ctx.effect(() => {
    unregisterHello()
    ctx.logger.info('[hello-plugin] unloaded')
  })
}
