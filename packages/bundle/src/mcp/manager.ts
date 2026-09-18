/**
 * 多 server 编排：**故障隔离**是这里的首要职责。
 *
 * 硬要求（逐条对上）：
 * - 启动期**异步**连接，失败绝不阻断 harness 启动：只告警并标记该 server 不可用（connectOne 不抛错）；
 * - 连接失败 / 握手版本不匹配的 server，其工具**不注册**（不注册一个永远失败的工具）；
 * - 子进程由 ctx.effect → dispose() 收尾（关 stdin → 等退出 → 超时强杀，Windows 连带子进程）；
 * - server 进程意外退出 → 标记不可用 + 告警；**不做自动重连**（避免"崩溃→重启→再崩"的僵尸循环）；
 * - 任何 MCP 异常都不得变成 unhandledRejection / 不得让 AgentLoop 抛错：
 *   连接期异常在此吞掉并转为状态；调用期异常在工具 execute 内转成 `{ error }`。
 */
import type { Logger } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import { McpClient } from './client.js'
import { buildMcpToolDefinition, mcpToolName } from './tools.js'
import type { McpClientInfo, McpServerConfig, McpServerStatus, McpToolDescriptor } from './types.js'

export interface McpClientManagerOptions {
  servers: McpServerConfig[]
  logger: Logger
  clientInfo: McpClientInfo
  /** 配置解析阶段的告警（在 start() 时统一输出）。 */
  configWarnings?: string[]
}

interface ServerEntry {
  config: McpServerConfig
  client?: McpClient
  tools: McpToolDescriptor[]
  status: McpServerStatus
  unregister: Array<() => void>
  registered: string[]
}

export class McpClientManager {
  private readonly entries: ServerEntry[]
  private started: Promise<void> | undefined
  private disposed = false

  constructor(private readonly opts: McpClientManagerOptions) {
    this.entries = opts.servers.map((config) => ({
      config,
      tools: [],
      status: { name: config.name, connected: false, toolCount: 0 },
      unregister: [],
      registered: [],
    }))
  }

  /** 已配置的 server 名（含不可用的）。 */
  get serverNames(): string[] {
    return this.entries.map((e) => e.config.name)
  }

  /** 连接完成的信号（供测试 / 诊断等待，不阻塞挂载）。 */
  ready(): Promise<void> {
    return this.start()
  }

  /** 连接全部 server：逐个隔离失败，永不 reject。 */
  start(): Promise<void> {
    this.started ??= this.connectAll()
    return this.started
  }

  statuses(): McpServerStatus[] {
    return this.entries.map((e) => ({ ...e.status }))
  }

  /** 已注册的工具名（未注册成功的不计入；dispose 后清空）。 */
  registeredToolNames(): string[] {
    return this.entries.flatMap((e) => e.registered)
  }

  /** 各 server 的子进程 pid（供诊断 / 审计「拉起了哪些进程」/ 测试断言进程确实退出）。 */
  pids(): Array<{ server: string; pid: number | undefined }> {
    return this.entries.map((e) => ({ server: e.config.name, pid: e.client?.pid }))
  }

  /** 把已连接 server 的工具注册进注册表；返回实际注册成功的工具名。 */
  registerTools(registry: ToolRegistry): string[] {
    if (this.disposed) return []
    const registered: string[] = []
    for (const entry of this.entries) {
      const client = entry.client
      if (!client || !client.alive) continue
      for (const tool of entry.tools) {
        const name = mcpToolName(entry.config.name, tool.name)
        const definition = buildMcpToolDefinition({
          serverName: entry.config.name,
          tool,
          resultMaxBytes: entry.config.resultMaxBytes,
          timeoutMs: entry.config.timeouts.callMs,
          logger: this.opts.logger,
          call: (toolName, toolArgs) => {
            if (!client.alive) {
              throw new Error(client.unavailableReason ?? `MCP server "${entry.config.name}" 当前不可用`)
            }
            return client.callTool(toolName, toolArgs)
          },
        })
        try {
          const unregister = registry.register(definition)
          entry.unregister.push(unregister)
          entry.registered.push(name)
          registered.push(name)
        } catch (err) {
          // 注册冲突（如同名内建工具已存在）不静默：告警并跳过，绝不动既有工具。
          this.opts.logger.warn(
            `[mcp:${entry.config.name}] 工具 "${name}" 注册失败，已跳过：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    return registered
  }

  /** 收尾：注销工具 + 关闭全部子进程（幂等）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries) {
      for (const unregister of entry.unregister) {
        try {
          unregister()
        } catch {
          /* 注销失败不影响收尾 */
        }
      }
      entry.unregister = []
      entry.registered = []
      const client = entry.client
      entry.client = undefined
      if (client) await client.close().catch(() => undefined)
      entry.status.connected = false
    }
  }

  private async connectAll(): Promise<void> {
    for (const warning of this.opts.configWarnings ?? []) {
      this.opts.logger.warn(`[mcp] 配置告警：${warning}`)
    }
    // 并发连接：单个 server 的慢/挂不影响其它 server（各自超时兜底）。
    await Promise.allSettled(this.entries.map((entry) => this.connectOne(entry)))
  }

  private async connectOne(entry: ServerEntry): Promise<void> {
    const { config } = entry
    const log = this.opts.logger
    const commandLine = [config.command, ...config.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ')
    log.info(`[mcp] 连接 server "${config.name}"：${commandLine}`)
    if (/^(npx|pnpm|npm|yarn|bunx|uvx|uv|pipx|docker)$/i.test(config.command)) {
      // "联网拉取即执行"类命令：不禁止（主流用法，且配置本身就是用户授权），但语义必须显式。
      log.warn(
        `[mcp:${config.name}] command "${config.command}" 属「联网拉取即执行」类：每次可能执行到不同版本的代码，` +
          '请只为此类 server 配置你信任的来源。',
      )
    }
    const client = new McpClient({ server: config, logger: log, clientInfo: this.opts.clientInfo })
    try {
      await client.connect()
      const tools = await client.listTools()
      if (this.disposed) {
        await client.close().catch(() => undefined)
        return
      }
      entry.client = client
      entry.tools = tools
      entry.status = {
        name: config.name,
        connected: true,
        era: client.era,
        protocolVersion: client.protocolVersion,
        toolCount: tools.length,
      }
      const info = client.serverInfo
      log.info(
        `[mcp] server "${config.name}" 就绪：协议 ${client.era}/${String(client.protocolVersion)}，` +
          `工具 ${tools.length} 个${info?.name ? `，serverInfo=${info.name}@${String(info.version)}` : ''}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      entry.status = { name: config.name, connected: false, toolCount: 0, error: message }
      // 不可用即不注册其工具；harness 启动不受影响。
      log.warn(`[mcp] server "${config.name}" 不可用，已跳过（其工具不会注册）：${message}`)
      await client.close().catch(() => undefined)
    }
  }
}
