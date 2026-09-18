import type { Sandbox } from '@zhuxing/harness-sandbox'
import type { Logger } from '@zhuxing/harness-kernel'
import type { ChatTool } from '@zhuxing/harness-llm'

/** 工具执行上下文。 */
export interface ToolExecuteContext {
  sandbox?: Sandbox
  logger?: Logger
  /** 执行前/后事件（tools/before-exec、tools/after-exec）。 */
  emit?: (event: string, payload?: unknown) => Promise<boolean>
  /** 当前运行的会话 id（用于会话私有记忆等需要感知当前对话的工具）。 */
  sessionId?: string
  /** 本次工具调用的 id（模型返回的 tool_call.id）：用于把同一次调用的事件与结果关联起来。 */
  callId?: string
}

/** 工具统一结果。 */
export interface ToolResult {
  text?: string
  json?: unknown
  error?: string
}

/** 沙箱守卫声明：执行前自动用对应参数值做命令/读路径/写路径裁决。 */
export interface ToolSandboxGuard {
  /** 取值参数名（命令）传给 checkCommand。 */
  commandArg?: string
  /** 取值参数名（读取路径）传给 checkRead。 */
  readArg?: string
  /** 取值参数名（路径）传给 checkWrite。 */
  writeArg?: string
}

/** 工具定义：schema 并入提示词组装，执行走统一管道。 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema（对象）。 */
  schema: Record<string, unknown>
  /** 单次执行超时（ms，默认 60_000）。调用方显式传入的 options.timeoutMs 优先。 */
  timeoutMs?: number
  sandbox?: ToolSandboxGuard
  execute(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<ToolResult> | ToolResult
}

export interface ToolExecuteOptions {
  timeoutMs?: number
  /** 失败重试次数，默认 0。 */
  retries?: number
}

/**
 * 工具注册表服务（ctx.tools）。
 *
 * 实现方实现 PluginScopedService.forPlugin：`ctx.inject('tools')` 拿到的是绑定该插件身份的视图，
 * 注册的工具会记录归属，执行时按插件声明的 permissions 裁决（治理点）。注意权限清单**不是隔离**：
 * 它只管经本注册表执行的参数，插件直接调用 Node API 不受约束。
 */
export interface ToolRegistry {
  /** 注册工具；返回注销函数（建议用 ctx.effect 绑定插件生命周期，卸载时自动清理）。 */
  register(def: ToolDefinition): () => void
  unregister(name: string): void
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  /** 转换为模型可见的工具列表。 */
  toChatTools(): ChatTool[]
  /** 执行管道：拦截 → 插件权限裁决 → 沙箱守卫 → 超时重试 → 结果规范化。 */
  execute(name: string, args: Record<string, unknown>, ctx: ToolExecuteContext, options?: ToolExecuteOptions): Promise<ToolResult>
}

export function toToolResultText(result: ToolResult): string {
  if (result.error !== undefined) return `[错误] ${result.error}`
  if (result.text !== undefined) return result.text
  if (result.json !== undefined) return JSON.stringify(result.json)
  return ''
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具执行超时（${ms}ms）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
