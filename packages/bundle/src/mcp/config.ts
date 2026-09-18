/**
 * `mcpServers` 配置解析与校验：**纯函数、无 I/O**，便于单测。
 *
 * 形状沿用生态惯例（Claude Desktop / Cursor 的配置可直接粘过来）：
 * ```json
 * "mcpServers": {
 *   "filesystem": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/path"],
 *                   "env": {"KEY":"v"}, "cwd": "..." }
 * }
 * ```
 * 非法条目**逐条告警并跳过**，不影响其它 server，也不影响 harness 启动。
 */
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
  DEFAULT_MCP_TIMEOUTS,
} from './types.js'
import type { McpConfigParseResult, McpServerConfig, McpTimeouts } from './types.js'

/** 合法 server 名的字符集（与工具名拼接后的可读性/兼容性考虑，比 MCP 工具名更严）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_.-]+$/

/** 视为「非 stdio 传输」的 type 取值（本客户端只做 stdio）。 */
const UNSUPPORTED_TRANSPORT_TYPES = new Set(['http', 'sse', 'streamable-http', 'streamable_http'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取正整数型超时覆盖；非法值忽略（返回 undefined）并在调用方告警。 */
function readPositiveInt(raw: unknown, label: string, warnings: string[]): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${label} 必须是正数，已忽略该覆盖值（改用默认值）`)
    return undefined
  }
  return Math.floor(n)
}

function readTimeouts(entry: Record<string, unknown>, serverName: string, warnings: string[]): McpTimeouts {
  const shared = readPositiveInt(entry.timeoutMs, `server "${serverName}" 的 timeoutMs`, warnings)
  const initMs = readPositiveInt(entry.initTimeoutMs, `server "${serverName}" 的 initTimeoutMs`, warnings)
  const listMs = readPositiveInt(entry.listTimeoutMs, `server "${serverName}" 的 listTimeoutMs`, warnings)
  const callMs = readPositiveInt(entry.callTimeoutMs, `server "${serverName}" 的 callTimeoutMs`, warnings)
  return {
    initMs: initMs ?? shared ?? DEFAULT_MCP_TIMEOUTS.initMs,
    listMs: listMs ?? shared ?? DEFAULT_MCP_TIMEOUTS.listMs,
    callMs: callMs ?? shared ?? DEFAULT_MCP_TIMEOUTS.callMs,
  }
}

function readStringMap(raw: unknown, label: string, warnings: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 必须是对象（键 → 字符串值），已跳过该 server`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      warnings.push(`${label}.${key} 必须是字符串，已跳过该 server`)
      return undefined
    }
    out[key] = value
  }
  return out
}

/**
 * 解析 `mcpServers`。返回可用 server 列表与逐条告警文本。
 *
 * 校验规则（违反即跳过该 server 并告警，绝不因单条非法配置整体崩）：
 * - 顶层必须是对象；
 * - `command` 必填、非空字符串；
 * - `args` 必须是字符串数组；
 * - `env` 必须是字符串值对象；`cwd` 必须是非空字符串；
 * - server 名非空且不得含 `__`（与 `mcp__<server>__<tool>` 命名冲突）。
 */
export function parseMcpServers(raw: unknown): McpConfigParseResult {
  const warnings: string[] = []
  const servers: McpServerConfig[] = []
  if (raw === undefined || raw === null) return { servers, warnings }
  if (!isPlainObject(raw)) {
    warnings.push('mcpServers 必须是对象（server 名 → { command, args?, env?, cwd? }），已整体忽略')
    return { servers, warnings }
  }

  for (const [name, value] of Object.entries(raw)) {
    const label = `server "${name}"`
    if (!name.trim()) {
      warnings.push('mcpServers 里存在空 server 名，已跳过')
      continue
    }
    if (name.includes('__')) {
      warnings.push(`${label} 的名称含 "__"，与工具命名 mcp__<server>__<tool> 冲突，已跳过`)
      continue
    }
    if (!SERVER_NAME_RE.test(name)) {
      warnings.push(`${label} 的名称含非法字符（仅允许字母/数字/_/-/.），已跳过`)
      continue
    }
    if (!isPlainObject(value)) {
      warnings.push(`${label} 的配置必须是对象，已跳过`)
      continue
    }
    if (value.disabled === true) {
      warnings.push(`${label} 已按配置停用（disabled=true），已跳过`)
      continue
    }
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
    if (typeof value.url === 'string' || UNSUPPORTED_TRANSPORT_TYPES.has(type)) {
      warnings.push(`${label} 声明了非 stdio 传输（url/type=${type || 'url'}），本客户端只支持 stdio（command/args），已跳过`)
      continue
    }
    const command = typeof value.command === 'string' ? value.command.trim() : ''
    if (!command) {
      warnings.push(`${label} 缺少必填的 command（非空字符串），已跳过`)
      continue
    }
    let args: string[] = []
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.some((a) => typeof a !== 'string')) {
        warnings.push(`${label} 的 args 必须是字符串数组，已跳过`)
        continue
      }
      args = value.args as string[]
    }
    const env = readStringMap(value.env, `${label} 的 env`, warnings)
    if (value.env !== undefined && env === undefined) continue
    let cwd: string | undefined
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== 'string' || !value.cwd.trim()) {
        warnings.push(`${label} 的 cwd 必须是非空字符串，已跳过`)
        continue
      }
      cwd = value.cwd
    }
    const resultMaxBytes =
      readPositiveInt(value.resultMaxBytes, `${label} 的 resultMaxBytes`, warnings) ?? DEFAULT_MCP_RESULT_MAX_BYTES
    servers.push({
      name,
      command,
      args,
      env,
      cwd,
      timeouts: readTimeouts(value, name, warnings),
      resultMaxBytes,
    })
  }
  return { servers, warnings }
}
