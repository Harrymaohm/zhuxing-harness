/**
 * MCP 协议客户端（stdio）：握手与版本协商、请求-响应关联、能力声明、超时、工具面。
 *
 * ## 版本协商（依据抓取的规范原文，见 types.ts 顶部注释）
 * 规范给 stdio 的双时代（dual-era）探测流程是**固定的三步**：
 * 1. 先发 `server/discover`，`_meta` 里声明首选现代版本 `2026-07-28`；
 * 2. 收到 `DiscoverResult` → 服务端是现代：从 `supportedVersions` 里选一个共同支持的版本，
 *    之后**每个请求**都在 `_meta.io.modelcontextprotocol/*` 携带协议版本与客户端能力；
 * 3. 收到**可识别的现代错误**（规范保留区间 `-32020`..`-32099`，如 `-32022`
 *    UnsupportedProtocolVersionError）→ 服务端是现代但版本不支持：**不得**回落 `initialize`；
 *    收到**任何其它错误或超时** → 服务端是旧版：回落到 `initialize` 握手（本客户端发 `2025-06-18`）。
 *
 * 服务端回了一个本客户端不支持的版本 → **断开**（规范：客户端不支持该版本时 SHOULD disconnect）。
 *
 * ## 能力声明（如实为空）
 * 本客户端**不**提供 `roots` / `sampling` / `elicitation`，因此 `capabilities` 声明为 `{}`：
 * 现代版本放在每请求 `_meta['io.modelcontextprotocol/clientCapabilities']`，旧版放在 `initialize.params`。
 * 规范要求 `protocolVersion` 与 `clientCapabilities` 在每个现代请求里**必填**，`clientInfo` 为 SHOULD。
 *
 * ## 关闭
 * 关 stdin → 等退出 → 超时强杀（见 transport.ts）。
 */
import type { Logger } from '@zhuxing/harness-kernel'
import { StdioTransport } from './transport.js'
import {
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  MCP_SUPPORTED_VERSIONS,
} from './types.js'
import type { McpClientInfo, McpServerConfig, McpToolDescriptor, McpTransportEra } from './types.js'

/** `tools/list` 的分页上限：防止服务端给出永无止境的 cursor（深分页属服务端异常）。 */
const MAX_TOOL_LIST_PAGES = 100

/** JSON-RPC 协议错误（服务端返回 error 对象）。 */
export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'McpProtocolError'
  }
}

/** 服务端以 MRTR 要求补充输入（`resultType: "input_required"`），而本客户端未声明相关能力。 */
export class McpInputRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpInputRequiredError'
  }
}

interface PendingEntry {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface McpClientOptions {
  server: McpServerConfig
  logger: Logger
  clientInfo: McpClientInfo
}

/** 是否属于「规范保留区间」的错误码：`-32020`..`-32099` 由 MCP 规范独占（见 2026-07-28 basic/index#error-codes）。 */
function isModernErrorCode(code: number): boolean {
  return code <= MCP_ERROR_HEADER_MISMATCH && code >= -32099
}

export class McpClient {
  /** 协商出的传输时代；握手完成后才有值。 */
  era: McpTransportEra | undefined
  /** 协商出的协议版本；握手完成后才有值。 */
  protocolVersion: string | undefined
  serverInfo: { name?: string; version?: string } | undefined

  private readonly transport: StdioTransport
  private readonly pending = new Map<number, PendingEntry>()
  private warnedServerRequests = new Set<string>()
  private nextId = 1
  private closed = false
  private failureReason: string | undefined

  constructor(private readonly opts: McpClientOptions) {
    this.transport = new StdioTransport(
      {
        serverName: opts.server.name,
        command: opts.server.command,
        args: opts.server.args,
        env: opts.server.env,
        cwd: opts.server.cwd,
        logger: opts.logger,
      },
      {
        onMessage: (message) => this.handleMessage(message),
        onExit: (info) => this.handleExit(info),
      },
    )
  }

  get name(): string {
    return this.opts.server.name
  }

  get alive(): boolean {
    return !this.closed && this.failureReason === undefined && this.transport.alive
  }

  /** 不可用原因（进程意外退出 / 握手失败）。 */
  get unavailableReason(): string | undefined {
    return this.failureReason
  }

  get pid(): number | undefined {
    return this.transport.pid
  }

  /** 拉起进程并完成握手（失败时自动收尾，绝不留下孤儿进程）。 */
  async connect(): Promise<void> {
    try {
      await this.transport.start()
      await this.handshake()
    } catch (err) {
      await this.close().catch(() => undefined)
      throw err
    }
  }

  /**
   * 列举工具（处理 `nextCursor` 分页）。
   * 规范要点：缺失 `nextCursor` 即结束；cursor 是不透明 token，**空字符串是合法 cursor**
   * （不得按「空」判定结束）；客户端的请求带 cursor、服务端决定页大小。
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const raw = await this.request('tools/list', cursor === undefined ? undefined : { cursor }, this.timeouts.listMs)
      const result = (raw ?? {}) as Record<string, unknown>
      if (Array.isArray(result.tools)) {
        for (const item of result.tools) {
          const descriptor = validateTool(item, this.opts.logger, this.name)
          if (descriptor) tools.push(descriptor)
        }
      } else {
        this.opts.logger.warn(`[mcp:${this.name}] tools/list 响应缺少 tools 数组，按空页处理`)
      }
      const next = result.nextCursor
      if (next === undefined || next === null) break
      if (typeof next !== 'string') {
        this.opts.logger.warn(`[mcp:${this.name}] tools/list 的 nextCursor 不是字符串，已停止分页`)
        break
      }
      if (seenCursors.has(next)) {
        this.opts.logger.warn(`[mcp:${this.name}] tools/list 返回了重复的 cursor，已停止分页`)
        break
      }
      seenCursors.add(next)
      cursor = next
      if (page === MAX_TOOL_LIST_PAGES - 1) {
        throw new Error(`MCP server "${this.name}" 的 tools/list 分页超过 ${MAX_TOOL_LIST_PAGES} 页，疑似服务端异常，已中止`)
      }
    }
    return tools
  }

  /** 调用工具：args 原样透传；返回原始 `result`（形状映射见 tools.ts）。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }, this.timeouts.callMs)
    const envelope = (result ?? {}) as Record<string, unknown>
    const resultType = envelope.resultType
    // 规范：缺失 resultType 一律按 "complete"（向后兼容旧版服务端）。
    if (resultType === undefined || resultType === 'complete') return envelope
    if (resultType === 'input_required') {
      throw new McpInputRequiredError(
        `MCP 工具 "${this.name}/${name}" 未完成：服务端要求补充输入（resultType=input_required，多轮往返 MRTR）。` +
          '本客户端未声明 elicitation / sampling / roots 能力，无法应答该交互；请改用不依赖交互的调用方式。',
      )
    }
    throw new Error(`MCP 工具 "${this.name}/${name}" 返回了本客户端不理解的 resultType："${String(resultType)}"`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failPending(`MCP server "${this.name}" 连接已关闭`)
    await this.transport.close()
  }

  // ---------------------------------------------------------------- 握手

  private get timeouts() {
    return this.opts.server.timeouts
  }

  private meta(): Record<string, unknown> {
    // 现代版本：协议版本与客户端能力为**每请求必填**；clientInfo 为 SHOULD（本客户端照发）。
    return {
      'io.modelcontextprotocol/protocolVersion': this.protocolVersion ?? MCP_MODERN_VERSION,
      'io.modelcontextprotocol/clientInfo': { ...this.opts.clientInfo },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
  }

  private buildParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (this.era === 'legacy') return params
    return { ...(params ?? {}), _meta: this.meta() }
  }

  private async handshake(): Promise<void> {
    const { logger, server } = this.opts
    let result: Record<string, unknown>
    try {
      result = ((await this.request('server/discover', undefined, this.timeouts.initMs)) ?? {}) as Record<string, unknown>
    } catch (err) {
      if (err instanceof McpProtocolError && isModernErrorCode(err.code)) {
        // 可识别的现代错误 → 服务端是现代：不得回落 initialize（规范明确）。
        if (err.code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION) {
          const supported = (err.data as { supported?: unknown } | undefined)?.supported
          const list = Array.isArray(supported) ? supported.join(', ') : '(未提供)'
          throw new Error(
            `MCP server "${server.name}" 不支持协议版本 ${MCP_MODERN_VERSION}（其声明支持：${list}）；` +
              `本客户端仅支持 ${MCP_SUPPORTED_VERSIONS.join(' / ')}，已断开（不回落 initialize）。`,
            { cause: err },
          )
        }
        throw new Error(
          `MCP server "${server.name}" 拒绝了现代握手（JSON-RPC ${err.code}：${err.message}）；本客户端未声明对应能力，已断开`,
          { cause: err },
        )
      }
      // 其它错误 / 无响应超时 → 旧版服务端：回落 initialize 握手（规范给定的 stdio 探测规则）。
      logger.info(
        `[mcp:${server.name}] server/discover 未得到现代响应（${
          err instanceof Error ? err.message : String(err)
        }），按旧版服务端回落 initialize 握手`,
      )
      await this.legacyInitialize()
      return
    }
    // 现代服务端：必须从 supportedVersions 里选出一个共同支持的版本，否则断开。
    const versions = Array.isArray(result.supportedVersions) ? (result.supportedVersions as unknown[]) : undefined
    if (versions && !versions.includes(MCP_MODERN_VERSION)) {
      throw new Error(
        `MCP server "${server.name}" 不支持协议版本 ${MCP_MODERN_VERSION}（其声明支持：${
          versions.length > 0 ? versions.join(', ') : '(空)'
        }）；本客户端仅支持 ${MCP_SUPPORTED_VERSIONS.join(' / ')}，已断开（规范：客户端不支持该版本时应断开）。`,
      )
    }
    if (!versions) {
      logger.warn(
        `[mcp:${server.name}] server/discover 响应缺少 supportedVersions（规范要求 MUST 提供），按 ${MCP_MODERN_VERSION} 继续`,
      )
    }
    this.era = 'modern'
    this.protocolVersion = MCP_MODERN_VERSION
    this.serverInfo = readServerInfo(result, logger, server.name)
    logger.info(
      `[mcp:${server.name}] 握手完成：现代协议 ${MCP_MODERN_VERSION}（server/discover + 每请求 _meta，无 initialize 握手）`,
    )
  }

  private async legacyInitialize(): Promise<void> {
    // 先落定 era = legacy 再发 initialize：buildParams 依 era 决定是否注入 _meta，
    // 而旧版（2025-06-18）的 initialize 参数只有 protocolVersion / capabilities / clientInfo，
    // **不带 _meta**。失败时回滚 era，避免留下半协商状态。
    this.era = 'legacy'
    let result: Record<string, unknown>
    try {
      result = (await this.request(
        'initialize',
        { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: { ...this.opts.clientInfo } },
        this.timeouts.initMs,
      )) as Record<string, unknown>
    } catch (err) {
      this.era = undefined
      throw err
    }
    const version = result?.protocolVersion
    if (version !== MCP_LEGACY_VERSION) {
      this.era = undefined
      throw new Error(
        `MCP server "${this.opts.server.name}" 协商出本客户端不支持的协议版本 "${String(version)}"；` +
          `本客户端仅支持 ${MCP_SUPPORTED_VERSIONS.join(' / ')}，已断开（规范：客户端不支持该版本时应断开）。`,
      )
    }
    this.protocolVersion = MCP_LEGACY_VERSION
    this.serverInfo = (result.serverInfo as { name?: string; version?: string } | undefined) ?? undefined
    // 规范：初始化成功后客户端 MUST 发 notifications/initialized。
    this.transport.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.opts.logger.info(
      `[mcp:${this.opts.server.name}] 握手完成：旧版协议 ${MCP_LEGACY_VERSION}（initialize + notifications/initialized）`,
    )
  }

  // ---------------------------------------------------------------- 请求-响应关联

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed || this.failureReason !== undefined) {
      return Promise.reject(new Error(this.failureReason ?? `MCP server "${this.name}" 连接已关闭`))
    }
    const id = this.nextId++
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    const finalParams = this.buildParams(params)
    if (finalParams !== undefined) message.params = finalParams

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 规范：请求超时应发 notifications/cancelled 并停止等待。
        this.transport.write({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: `${method} 超时（${timeoutMs}ms）` },
        })
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms，server=${this.name}）`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      if (!this.transport.write(message)) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(this.failureReason ?? `MCP server "${this.name}" 进程不可用，无法发送 ${method}`))
      }
    })
  }

  private settle(id: number, done: (entry: PendingEntry) => void): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    done(entry)
  }

  private failPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const rawId = message.id
    const id = typeof rawId === 'number' ? rawId : Number(rawId)
    if (!Number.isFinite(id)) {
      this.opts.logger.warn(`[mcp:${this.name}] 收到无法识别的响应 id（${String(rawId)}），已忽略`)
      return
    }
    if (!this.pending.has(id)) {
      this.opts.logger.warn(`[mcp:${this.name}] 收到未知 id 的响应（${String(rawId)}），已忽略`)
      return
    }
    const error = message.error
    if (error !== undefined && error !== null) {
      const detail = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown }
      const code = typeof detail.code === 'number' ? detail.code : 0
      this.settle(id, (entry) =>
        entry.reject(new McpProtocolError(code, String(detail.message ?? '未知协议错误'), detail.data)),
      )
      return
    }
    this.settle(id, (entry) => entry.resolve(message.result))
  }

  /** 服务端 → 客户端请求：现代版本禁止出现；旧版可出现但本客户端未声明能力，故拒绝。 */
  private handleServerRequest(message: Record<string, unknown>): void {
    const method = String(message.method)
    if (!this.warnedServerRequests.has(method)) {
      this.warnedServerRequests.add(method)
      this.opts.logger.warn(
        `[mcp:${this.name}] 服务端发起了 JSON-RPC 请求 "${method}"；本客户端未声明 roots/sampling/elicitation 能力，` +
          (this.era === 'modern'
            ? `且 ${MCP_MODERN_VERSION} 明确禁止服务端向客户端发请求（应改用 Multi-Round-Trip 的 InputRequiredResult），已忽略`
            : '已按未实现的能力拒绝'),
      )
    }
    if (this.era === 'modern') return // 现代版本：客户端 MUST NOT 写响应，只能忽略
    this.transport.write({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32601,
        message: `客户端未声明能力，无法处理 ${method}（本客户端只实现 tools，不含 roots/sampling/elicitation）`,
      },
    })
  }

  private handleNotification(message: Record<string, unknown>): void {
    const method = String(message.method)
    if (method === 'notifications/tools/list_changed') {
      this.opts.logger.info(
        `[mcp:${this.name}] 服务端通知工具列表已变化；本客户端不做动态刷新（工具面在连接时快照，重启会话即可更新）`,
      )
      return
    }
    this.opts.logger.debug(`[mcp:${this.name}] 收到通知 ${method}（已忽略）`)
  }

  private handleMessage(message: Record<string, unknown>): void {
    const hasId = message.id !== undefined && message.id !== null
    const hasMethod = typeof message.method === 'string'
    if (hasMethod && hasId) {
      this.handleServerRequest(message)
      return
    }
    if (hasMethod) {
      this.handleNotification(message)
      return
    }
    if (hasId) {
      this.handleResponse(message)
      return
    }
    this.opts.logger.warn(`[mcp:${this.name}] 收到无法归类的 JSON-RPC 消息，已忽略`)
  }

  private handleExit(info: { code: number | null; signal: string | null; expected: boolean }): void {
    const detail = `进程已退出（code=${String(info.code)}，signal=${String(info.signal)}）`
    if (info.expected) {
      this.opts.logger.debug(`[mcp:${this.name}] ${detail}`)
      this.failPending(`MCP server "${this.name}" 已关闭`)
      return
    }
    this.failureReason = `MCP server "${this.name}" ${detail}`
    // 不做自动重连：避免"崩溃→重启→再崩"的僵尸循环。工具保持已注册，调用时快速失败并给出可读原因。
    this.opts.logger.warn(
      `[mcp:${this.name}] ${detail}；该 server 标记为不可用（其工具调用将返回可读错误）。本客户端不做自动重连，请重启会话。`,
    )
    this.failPending(this.failureReason)
  }
}

/** 校验并归一化单个工具描述（name 必填、inputSchema 必须是对象）。 */
function validateTool(item: unknown, logger: Logger, serverName: string): McpToolDescriptor | undefined {
  if (typeof item !== 'object' || item === null) {
    logger.warn(`[mcp:${serverName}] tools/list 里出现非对象条目，已跳过`)
    return undefined
  }
  const tool = item as Record<string, unknown>
  const name = typeof tool.name === 'string' ? tool.name.trim() : ''
  if (!name) {
    logger.warn(`[mcp:${serverName}] tools/list 里有工具缺少 name，已跳过`)
    return undefined
  }
  if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema)) {
    // 规范：inputSchema MUST 是合法 JSON Schema 对象。缺失 schema 会让模型对参数一无所知，
    // 与其注册一个参数含义不明的工具，不如告警并跳过（不让模型瞎猜参数）。
    logger.warn(`[mcp:${serverName}] 工具 "${name}" 缺少合法 inputSchema（JSON Schema 对象），已跳过注册`)
    return undefined
  }
  return {
    name,
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    outputSchema: tool.outputSchema,
  }
}

function readServerInfo(
  result: Record<string, unknown>,
  logger: Logger,
  serverName: string,
): { name?: string; version?: string } | undefined {
  const meta = result?._meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const info = (meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']
  if (typeof info !== 'object' || info === null) {
    logger.debug(`[mcp:${serverName}] server/discover 未提供 serverInfo`)
    return undefined
  }
  const record = info as Record<string, unknown>
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
  }
}
