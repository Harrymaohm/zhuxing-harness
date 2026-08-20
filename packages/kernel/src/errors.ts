/**
 * 结构化错误与输出安全工具。
 */

/** 错误分类码。 */
export type HarnessErrorCode =
  | 'AUTH' // 认证失败
  | 'NETWORK' // 网络/代理问题
  | 'CONFIG' // 配置错误
  | 'PERMISSION' // 沙箱/权限拒绝
  | 'PLUGIN' // 插件加载/挂载失败
  | 'TIMEOUT' // 超时
  | 'UNKNOWN'

/** 统一错误类型：携带分类码与修复建议，供 CLI 层人类可读化。 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly hint?: string

  constructor(message: string, code: HarnessErrorCode = 'UNKNOWN', hint?: string) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    this.hint = hint
  }

  static from(err: unknown): HarnessError {
    if (err instanceof HarnessError) return err
    if (err instanceof Error) {
      // 根据消息启发式分类
      if (/401|unauthorized|invalid.*key|apikey|api key/i.test(err.message)) {
        return new HarnessError(err.message, 'AUTH', '请运行 harness login 重新配置 API Key，或检查 DEEPSEEK_API_KEY 环境变量。')
      }
      if (/fetch failed|connect timeout|ENOTFOUND|ECONNREFUSED|ENETUNREACH|proxy/i.test(err.message)) {
        return new HarnessError(err.message, 'NETWORK', '请检查网络连接与代理设置，确认 --base-url 端点可访问。')
      }
      if (/超时|timeout|abort/i.test(err.message)) {
        return new HarnessError(err.message, 'TIMEOUT', '任务超时。可加大 --timeout / 检查模型端点响应速度。')
      }
      if (/read-only|workspace-write|sandbox|权限|工作区外/i.test(err.message)) {
        return new HarnessError(err.message, 'PERMISSION', '沙箱策略拒绝。如需更高权限，请使用 --level workspace-write 或 danger-full-access。')
      }
      if (/插件|挂载失败|plugin|依赖|循环依赖|inject/i.test(err.message)) {
        return new HarnessError(err.message, 'PLUGIN', '请运行 harness validate <插件路径> 校验插件定义。')
      }
    }
    return new HarnessError(err instanceof Error ? err.message : String(err), 'UNKNOWN')
  }
}

const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/g
const ENV_SECRET_PATTERN = /(api[_\-]?key|token|secret)\s*[=:]\s*(['"]?)([A-Za-z0-9._-]{8,})\2/gi

/** 输出脱敏：将常见 API Key / 令牌替换为掩码，防止日志、截图、分享泄露凭证。 */
export function maskSecrets(text: string): string {
  if (!text) return ''
  let masked = text.replace(SECRET_PATTERN, (match) => {
    if (match.length <= 9) return match
    return `${match.slice(0, 3)}***${match.slice(-3)}`
  })
  masked = masked.replace(ENV_SECRET_PATTERN, (match, _key: string, _q: string, value: string) => {
    return match.replace(value, `${value.slice(0, 2)}***${value.slice(-2)}`)
  })
  return masked
}
