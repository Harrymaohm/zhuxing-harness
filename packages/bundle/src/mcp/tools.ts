/**
 * MCP 工具 → 本仓工具注册表的映射，以及**结果形状映射与大小上限**。
 *
 * 依据（.../2026-07-28/server/tools 与 .../2025-06-18/server/tools）：
 * - `tools/list` 的每个工具含 `name` / `description` / `inputSchema`（JSON Schema 对象）；
 * - `tools/call` 的结果是 `{ resultType?, content: [...], isError?, structuredContent? }`；
 *   缺失 `resultType` 一律按 `"complete"`（向后兼容旧版）；
 * - 内容块类型：`text` / `image` / `audio` / `resource_link` / `resource` 以及扩展类型；
 * - 工具级错误用 `isError: true` 表达，协议级错误用 JSON-RPC `error` 表达（后者由 client 抛出）。
 *
 * 结果大小必须有上限：MCP 工具可能一次返回几十万字符把上下文灌爆，这里按字节截断并**明确标注**。
 */
import type { ToolDefinition, ToolResult } from '@zhuxing/harness-tools'
import type { Logger } from '@zhuxing/harness-kernel'
import type { McpToolDescriptor } from './types.js'

/** 工具名前缀（生态惯例）：`mcp__<server>__<tool>`。 */
export const MCP_TOOL_PREFIX = 'mcp'

/** 工具名合法字符集（MCP 工具名规范建议仅 A-Za-z0-9_-.，其余替换以免被模型/上游拒绝）。 */
export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

/** 注册名：server 名已在配置层校验不含 `__`，故分隔符无歧义。 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}__${serverName}__${sanitizeToolName(toolName)}`
}

/** 按 UTF-8 字节截断，并在截断时追加可读标注。 */
export function truncateByBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return text
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return `${cut}\n…（结果已截断：原始 ${bytes} 字节，上限 ${maxBytes} 字节；如需完整内容请让 MCP server 缩小返回范围）`
}

/** 把 `content` 数组降级成文本。非文本类型**如实降级并说明**，不假装支持图片/音频。 */
export function contentToText(content: unknown, onWarn: (message: string) => void): string {
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) onWarn('content 不是数组，已按原始值处理')
    return ''
  }
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) {
      onWarn('content 里出现非对象条目，已跳过')
      continue
    }
    const block = item as Record<string, unknown>
    const type = typeof block.type === 'string' ? block.type : ''
    switch (type) {
      case 'text':
        parts.push(typeof block.text === 'string' ? block.text : '')
        break
      case 'image':
        parts.push(`[图片内容已降级省略：本客户端不把图片回填给模型（mimeType=${String(block.mimeType ?? '未知')}，base64 ${String(block.data ?? '').length} 字符）]`)
        break
      case 'audio':
        parts.push(`[音频内容已降级省略：本客户端不把音频回填给模型（mimeType=${String(block.mimeType ?? '未知')}，base64 ${String(block.data ?? '').length} 字符）]`)
        break
      case 'resource_link':
        parts.push(`[资源链接：${String(block.uri ?? '(无 uri)')}]`)
        break
      case 'resource': {
        const resource = (block.resource ?? {}) as Record<string, unknown>
        const uri = String(resource.uri ?? '(无 uri)')
        parts.push(
          typeof resource.text === 'string' ? `[嵌入资源 ${uri}]\n${resource.text}` : `[嵌入资源 ${uri}：二进制内容已省略]`,
        )
        break
      }
      default:
        onWarn(`content 里出现本客户端不支持的内容类型 "${type || '(缺 type)'}"，已忽略`)
        parts.push(`[不支持的内容类型 "${type || '(缺 type)'}"，已忽略]`)
        break
    }
  }
  return parts.filter((p) => p !== '').join('\n')
}

/**
 * `tools/call` 的原始 result → 本仓 `ToolResult`。
 * - `isError: true` → `{ error }`（含服务端给出的原因）；
 * - 其余 → `{ text }`（非文本内容如实降级标注；只有 structuredContent 时用其 JSON 兜底）；
 * - 一律施加字节上限。
 */
export function mapToolCallResult(
  serverName: string,
  toolName: string,
  result: unknown,
  maxBytes: number,
  logger: Logger,
): ToolResult {
  const warn = (message: string) => logger.warn(`[mcp:${serverName}] 工具 "${toolName}" ${message}`)
  if (typeof result !== 'object' || result === null) {
    return { text: truncateByBytes(JSON.stringify(result ?? null) ?? 'null', maxBytes) }
  }
  const envelope = result as Record<string, unknown>
  const text = contentToText(envelope.content, warn)
  if (envelope.isError === true) {
    const reason = text || '(服务端未给出错误说明)'
    return { error: truncateByBytes(`MCP 工具 "${serverName}/${toolName}" 返回错误：${reason}`, maxBytes) }
  }
  let out = text
  if (out === '' && envelope.structuredContent !== undefined) {
    // 规范建议返回结构化内容时同时给 JSON 文本；服务端只给 structuredContent 时由客户端兜底序列化。
    out = JSON.stringify(envelope.structuredContent) ?? ''
  }
  return { text: truncateByBytes(out === '' ? '(MCP 工具未返回内容)' : out, maxBytes) }
}

/** 为单个 MCP 工具生成注册定义。 */
export function buildMcpToolDefinition(args: {
  serverName: string
  tool: McpToolDescriptor
  resultMaxBytes: number
  /** 单次调用上限（工具定义层再多留一点余量，保证先返回本客户端构造的可读超时错误）。 */
  timeoutMs: number
  logger: Logger
  call: (toolName: string, toolArgs: Record<string, unknown>) => Promise<unknown>
}): ToolDefinition {
  const { serverName, tool, resultMaxBytes, timeoutMs, logger, call } = args
  return {
    name: mcpToolName(serverName, tool.name),
    // 描述直用服务端给出的文案（不加工、不臆造能力）。
    description: tool.description ?? `(MCP server "${serverName}" 未提供描述)`,
    schema: tool.inputSchema,
    // 注册表超时留 5s 余量：让 client 自己的超时先触发，错误信息更具体（含 server 名与方法名）。
    timeoutMs: timeoutMs + 5000,
    execute: async (toolArgs) => {
      try {
        const result = await call(tool.name, toolArgs)
        return mapToolCallResult(serverName, tool.name, result, resultMaxBytes, logger)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
