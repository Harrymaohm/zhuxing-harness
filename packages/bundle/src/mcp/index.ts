/** MCP（Model Context Protocol）stdio 客户端：对外导出面（协议实现 + 配置解析 + 工具映射）。 */
export {
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  DEFAULT_MCP_RESULT_MAX_BYTES,
  DEFAULT_MCP_TIMEOUTS,
} from './types.js'
export type {
  McpClientInfo,
  McpConfigParseResult,
  McpServerConfig,
  McpServerStatus,
  McpTimeouts,
  McpToolDescriptor,
  McpTransportEra,
} from './types.js'

export { parseMcpServers } from './config.js'
export { encodeMessage, isJsonRpcMessage, LineBuffer, parseLine, MAX_LINE_CHARS } from './framing.js'
export { StdioTransport } from './transport.js'
export type { StdioExitInfo, StdioTransportHandlers, StdioTransportOptions } from './transport.js'
export { McpClient, McpInputRequiredError, McpProtocolError } from './client.js'
export type { McpClientOptions } from './client.js'
export { McpClientManager } from './manager.js'
export type { McpClientManagerOptions } from './manager.js'
export { buildMcpToolDefinition, contentToText, MCP_TOOL_PREFIX, mapToolCallResult, mcpToolName, sanitizeToolName, truncateByBytes } from './tools.js'
