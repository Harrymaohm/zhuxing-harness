/**
 * MCP（Model Context Protocol）客户端插件装配。
 *
 * 位置选择：本插件只 inject `tools`，故紧随 `harness-core-tools` 之后挂载
 * （工具域插件连续，便于审阅「工具从哪来」）；它不依赖也不影响其它域。
 *
 * ## 权限可审计
 * 插件声明 `permissions.shell = [配置里出现的所有 command]`，让「会拉起哪些进程」在
 * 审计视图（harness introspect plugins / 已装插件清单）里可见。注意语义边界（与
 * packages/kernel/src/types.ts 的说明一致）：权限清单是**治理与审计**，不是隔离；
 * 本插件的工具没有 sandbox 参数语义，故该声明不构成执行前的强制点。
 *
 * ## 为什么不做"看起来完整"的能力声明
 * 本客户端不提供 roots / sampling / elicitation，因此在协议层如实声明空能力
 * （见 mcp/client.ts 的 `_meta` 与 initialize capabilities）。声明未实现的能力会让服务端
 * 发出我们无法应答的请求，属于**错误的能力承诺**。
 */
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import { parseMcpServers } from '../mcp/config.js'
import { McpClientManager } from '../mcp/manager.js'
import { currentVersion } from '../self-knowledge.js'

/**
 * @param deps.mcpServers 原始 `mcpServers` 配置（形状见 mcp/config.ts）；未配置时不产生任何插件。
 * @param deps.pluginId 插件 id（缺省 harness-mcp-client），便于测试注入独立实例。
 */
export function mcpPlugins(deps: { mcpServers?: unknown; pluginId?: string }): PluginDefinition[] {
  const hasConfig = deps.mcpServers !== undefined && deps.mcpServers !== null
  const parsed = parseMcpServers(deps.mcpServers)
  // 未配置 mcpServers 时**不注册插件**：默认装配与未接入 MCP 完全一致（零开销、零行为变化）。
  // 配置存在但全部非法时仍注册，只为把逐条告警如实打出来。
  if (parsed.servers.length === 0 && !hasConfig) return []

  return [
    {
      name: deps.pluginId ?? 'harness-mcp-client',
      description:
        `MCP（Model Context Protocol）stdio 客户端：连接外部 MCP server 并把其工具注册为 mcp__<server>__<tool>` +
        `（已配置 ${parsed.servers.length} 个 server）`,
      inject: ['tools'],
      provides: ['mcp'],
      permissions: { shell: parsed.servers.map((s) => s.command) },
      apply(ctx) {
        const tools = ctx.inject<ToolRegistry>('tools')
        const manager = new McpClientManager({
          servers: parsed.servers,
          logger: ctx.logger,
          clientInfo: { name: 'zhuxing-harness', title: '筑星 Harness', version: currentVersion() },
          configWarnings: parsed.warnings,
        })
        ctx.provide('mcp', manager)
        // 子进程收尾绑定插件生命周期（关 stdin → 等退出 → 超时强杀）。
        ctx.effect(() => manager.dispose())
        // 连接是**异步**的：绝不阻塞 harness 启动；失败由 manager 内部逐 server 隔离并告警。
        // 注意：任务开始前由调用方（cli run / dev、runtime 的 createKernel）显式 await manager.ready()，
        // 以保证首个任务就能看到配置好的工具面；那一步等待的是「工具面就绪」，不是「挂载成功」——
        // 失败永远不会让挂载或启动失败（ready() 不 reject）。
        ctx.track(
          manager
            .start()
            .then(() => {
              const names = manager.registerTools(tools)
              if (names.length > 0) ctx.logger.info(`[mcp] 已注册 ${names.length} 个 MCP 工具：${names.join(', ')}`)
            })
            .catch((err: unknown) => {
              // 兜底：manager.start 设计上不 reject；真出现意外也绝不能变成 unhandledRejection。
              ctx.logger.warn(`[mcp] 初始化异常（已忽略，不影响 harness）：${err instanceof Error ? err.message : String(err)}`)
            }),
        )
      },
    },
  ]
}
