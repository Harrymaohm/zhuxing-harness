/**
 * 插件权限清单在 harness 边界的**强制点**：只裁决「经工具注册表执行的工具调用参数」。
 *
 * 能力边界（必须如实理解，不要当成隔离）：插件是**进程内任意 JS 代码**，它可以
 * `import('node:fs')` / `child_process` 直接访问资源，那样做**不经过本文件**、也不受本检查约束。
 * 因此：
 * - 本检查是**治理与审计**（让声明的资源需求成为可裁决、可留痕的事实），不是沙箱，不是进程隔离；
 * - 真正拦得住「被篡改的第三方插件」的是**加载前的签名校验**（plugin-signature.ts），不是这里。
 *
 * 裁决规则（按维度独立判定；某个维度未声明即视为该维度不设限）：
 * - `fsRead` / `fsWrite`：参数里的路径（`sandbox.readArg` / `sandbox.writeArg`）必须落在声明范围内；
 * - `shell`：命令首词必须命中白名单（`sandbox.commandArg`）；
 * - `net` / `env`：目前**仅声明、无强制点**（工具元数据里没有 host/env 参数语义），只用于审计与自省。
 */
import { resolve } from 'node:path'
import type { PluginPermissions } from '@zhuxing/harness-kernel'
import type { ToolDefinition } from './types.js'

/** 路径比较归一化：绝对化 + Windows 下忽略大小写（其余平台保持大小写敏感）。 */
function normalizePath(p: string): string {
  const abs = resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 命令首词归一化：去引号、取 basename、Windows 下去掉可执行扩展名。 */
export function commandNameOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const unquoted = first.replace(/^["']|["']$/g, '')
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted
  const trimmed = process.platform === 'win32' ? base.replace(/\.(exe|cmd|bat|ps1)$/i, '') : base
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** glob → 正则（只支持 `**`、`*`、`?`，不引入依赖）。 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** 路径是否落在声明的范围（绝对路径前缀或 glob）内。 */
export function matchesPathScope(target: string, scope: string): boolean {
  const t = normalizePath(target)
  const s = normalizePath(scope)
  if (!s.includes('*') && !s.includes('?')) {
    if (t === s) return true
    return s.endsWith('/') ? t.startsWith(s) : t.startsWith(`${s}/`)
  }
  return globToRegExp(s).test(t)
}

/** 各维度的拒绝原因（返回 undefined 表示放行）。 */
function checkPath(
  toolName: string,
  pluginId: string,
  dimension: 'fsRead' | 'fsWrite',
  value: string,
  scopes: string[],
): string | undefined {
  if (scopes.some((s) => matchesPathScope(value, s))) return undefined
  const declared = scopes.length > 0 ? scopes.join(', ') : '(空，等价于全部拒绝)'
  return `工具 "${toolName}" 被插件权限拒绝：插件 "${pluginId}" 声明的 ${dimension} 未覆盖路径 "${value}"（已声明：${declared}）`
}

/**
 * 校验一次工具调用是否落在所属插件声明的权限范围内。
 * @returns 拒绝原因（可读、含越界的实际值）；undefined 表示允许执行。
 */
export function checkPluginPermissions(
  toolName: string,
  def: ToolDefinition,
  args: Record<string, unknown>,
  permissions: PluginPermissions,
  pluginId: string,
): string | undefined {
  const guard = def.sandbox
  if (!guard) return undefined

  if (guard.writeArg && permissions.fsWrite && args[guard.writeArg] !== undefined) {
    const bad = checkPath(toolName, pluginId, 'fsWrite', String(args[guard.writeArg]), permissions.fsWrite)
    if (bad) return bad
  }
  if (guard.readArg && permissions.fsRead && args[guard.readArg] !== undefined) {
    const bad = checkPath(toolName, pluginId, 'fsRead', String(args[guard.readArg]), permissions.fsRead)
    if (bad) return bad
  }
  if (guard.commandArg && permissions.shell && args[guard.commandArg] !== undefined) {
    const command = String(args[guard.commandArg])
    const name = commandNameOf(command)
    const allowed = permissions.shell.some((s) => commandNameOf(s) === name)
    if (!allowed) {
      const declared = permissions.shell.length > 0 ? permissions.shell.join(', ') : '(空，等价于全部拒绝)'
      return `工具 "${toolName}" 被插件权限拒绝：插件 "${pluginId}" 声明的 shell 白名单不含命令 "${name}"（已声明：${declared}）`
    }
  }
  return undefined
}
