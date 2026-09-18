/**
 * MCP（Model Context Protocol）stdio 客户端的类型与协议常量。
 *
 * 版本事实（2026-09-18 抓取 modelcontextprotocol.io 规范原文核实，非凭印象）：
 * - `2026-07-28` 是「现代」版本：**没有 `initialize` 握手**，也**没有连接期会话**。
 *   规范原文（.../2026-07-28/changelog「Make MCP stateless: remove the
 *   `initialize`/`notifications/initialized` handshake」；.../basic/versioning「There is no
 *   negotiation handshake. Every request carries its protocol version」）——协议版本、客户端能力
 *   **每个请求**都必须放在 `_meta.io.modelcontextprotocol/*` 里内联携带（stdio 没有 header 层）。
 * - `2025-06-18` 是「旧版」版本：`initialize` 握手 + `notifications/initialized`，之后请求不带 `_meta`。
 * - 规范的 era 术语：Modern = `2026-07-28` 及以后；Legacy = `2025-11-25` 及以前（`2025-06-18` 属 legacy）。
 *   双时代（dual-era）客户端在 stdio 上的探测方式由规范给定：先发 `server/discover`，只有收到
 *   「可识别的现代错误」才认定服务端是现代，否则（其它错误 / 无响应超时）回落到 `initialize`
 *   ——见 .../2026-07-28/basic/transports/stdio「Backward Compatibility」。
 *
 * 因此本客户端的双版本协商 = `server/discover` 探测 + 现代错误码判定 + `initialize` 回落，
 * 而**不是**「在 initialize 里发 2026-07-28」。后者在本规范下不存在。
 */

/** 本客户端支持的「现代」协议版本：按请求内联 `_meta`，无握手。 */
export const MCP_MODERN_VERSION = '2026-07-28'

/** 本客户端支持的「旧版」协议版本：`initialize` 握手 + 通知就绪。 */
export const MCP_LEGACY_VERSION = '2025-06-18'

/** 本客户端支持的协议版本集合（现代在前：`server/discover` 里声明首选版本）。 */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_MODERN_VERSION, MCP_LEGACY_VERSION]

/**
 * 规范保留错误码（`-32020`..`-32099` 由规范独占；见 .../2026-07-28/basic/index#error-codes）。
 * 收到该区间的错误即认定服务端是「现代」——**不得**回落到 `initialize`
 * （.../basic/transports/stdio：「Do not fall back to initialize」）。
 */
export const MCP_ERROR_HEADER_MISMATCH = -32020
export const MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022

/** MCP 客户端身份（`clientInfo`，规范为 Implementation：`{name, title?, version}`）。 */
export interface McpClientInfo {
  name: string
  title?: string
  version: string
}

/** 三阶段独立超时（ms）；均允许按 server 覆盖。 */
export interface McpTimeouts {
  /** `server/discover` 探测与 `initialize` 握手各自的上限。 */
  initMs: number
  /** 单次 `tools/list` 的上限（分页时每页各自计时）。 */
  listMs: number
  /** 单次 `tools/call` 的上限。 */
  callMs: number
}

export const DEFAULT_MCP_TIMEOUTS: McpTimeouts = { initMs: 10_000, listMs: 15_000, callMs: 60_000 }

/** 单个工具结果的字节上限：MCP 工具可能把上下文灌爆，必须截断。 */
export const DEFAULT_MCP_RESULT_MAX_BYTES = 64 * 1024

/** 解析并校验后的单个 server 配置（形状沿用 Claude Desktop / Cursor 的 `mcpServers`）。 */
export interface McpServerConfig {
  /** 配置里的 server 名（不得含 `__`，否则与 `mcp__<server>__<tool>` 命名冲突）。 */
  name: string
  /** 可执行文件；Windows 下非 `.exe` 的裸命令经 cmd.exe 启动（见 transport.ts）。 */
  command: string
  args: string[]
  /** 追加/覆盖到子进程环境变量上的键值。 */
  env?: Record<string, string>
  /** 子进程工作目录。 */
  cwd?: string
  timeouts: McpTimeouts
  resultMaxBytes: number
}

/** server 连接实况（供自省 / 诊断 / 评测探测）。 */
export interface McpServerStatus {
  name: string
  connected: boolean
  /** 协商出的传输时代。 */
  era?: McpTransportEra
  /** 协商出的协议版本。 */
  protocolVersion?: string
  /** 成功列举出的工具数。 */
  toolCount: number
  /** 不可用原因（连接/握手/列举失败）。 */
  error?: string
}

/** 协商出的传输时代：现代 = 按请求 `_meta`；旧版 = `initialize` 握手。 */
export type McpTransportEra = 'modern' | 'legacy'

/** `tools/list` 返回的单个工具（只取本客户端用得到的字段）。 */
export interface McpToolDescriptor {
  name: string
  description?: string
  /** MCP 的 inputSchema 就是 JSON Schema，直接作为工具注册表的 schema。 */
  inputSchema: Record<string, unknown>
  /** 服务端声明的输出 schema（仅记录，不做校验）。 */
  outputSchema?: unknown
}

/** `parseMcpServers` 的结果：可用 server + 逐条告警（非法配置跳过但不整体崩）。 */
export interface McpConfigParseResult {
  servers: McpServerConfig[]
  warnings: string[]
}
