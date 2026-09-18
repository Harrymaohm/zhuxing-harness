/**
 * stdio 帧格式：**换行分隔的单行 JSON-RPC**。
 *
 * 规范原文（2026-07-28 与 2025-06-18 的 `basic/transports` 一致）：
 * - 「Messages are delimited by newlines, and MUST NOT contain embedded newlines.」
 * - 「The server MUST NOT write anything to its `stdout` that is not a valid MCP message.」
 * - 「The client MUST NOT write anything to the server's `stdin` that is not a valid MCP message.」
 * - stderr 只用于日志，客户端「SHOULD NOT assume `stderr` output indicates error conditions」。
 *
 * 服务端违规时（stdout 混入非 MCP 内容）客户端**不能崩**：这里给出容错解析，
 * 由调用方把被丢弃的行记成告警。客户端侧则保证只写合法 JSON-RPC 单行消息。
 */

/** 单行上限：防止服务端一直不换行把内存吃光（正常 MCP 消息远小于此）。 */
export const MAX_LINE_CHARS = 1 << 20

/** 把一条 JSON-RPC 消息编码成单行（含结尾换行）；消息内不得含换行。 */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * 逐行拆帧：把 stdout 的到达块切成完整行，跨块的半行留在缓冲里。
 * 行内 CRLF 的 `\r` 会被剥掉；空行直接跳过（空行不是消息，不值得告警）。
 */
export class LineBuffer {
  private buffer = ''
  /** 出现过超长未换行内容（已丢弃），供调用方告警。 */
  overflowed = false

  push(chunk: string): string[] {
    this.buffer += chunk
    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? ''
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = ''
      this.overflowed = true
    }
    const lines: string[] = []
    for (const part of parts) {
      const line = part.endsWith('\r') ? part.slice(0, -1) : part
      if (line.trim() !== '') lines.push(line)
    }
    return lines
  }
}

/** 客户端只发合法 JSON-RPC；这里用于校验自身构造的消息（防御性断言）。 */
export function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).jsonrpc === '2.0' &&
    (typeof (value as Record<string, unknown>).method === 'string' || 'result' in value || 'error' in value)
  )
}

/** 解析结果：ok 时为消息体；fail 时给出可读原因（供告警）。 */
export type LineParseResult = { ok: true; message: Record<string, unknown> } | { ok: false; reason: string }

/** 解析单行；非 JSON / 非 JSON-RPC / 缺 `jsonrpc: "2.0"` 都算违规（调用方告警后继续）。 */
export function parseLine(line: string): LineParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, reason: '不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '不是 JSON 对象' }
  }
  if ((parsed as Record<string, unknown>).jsonrpc !== '2.0') {
    return { ok: false, reason: '缺少 jsonrpc: "2.0"' }
  }
  return { ok: true, message: parsed as Record<string, unknown> }
}
