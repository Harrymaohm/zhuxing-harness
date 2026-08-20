import type { ChatTool } from '@zhuxing/harness-llm'
import type { ToolDefinition, ToolExecuteContext, ToolExecuteOptions, ToolRegistry, ToolResult } from './types.js'
import { withTimeout } from './types.js'

/** 工具注册表实现：注册 + 统一执行管道（拦截 → 沙箱守卫 → 超时重试 → 结果规范化）。 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(def: ToolDefinition): () => void {
    if (this.tools.has(def.name)) {
      throw new Error(`[tools] 工具 "${def.name}" 已注册，禁止重复注册。`)
    }
    this.tools.set(def.name, def)
    return () => this.unregister(def.name)
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  toChatTools(): ChatTool[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext,
    options: ToolExecuteOptions = {},
  ): Promise<ToolResult> {
    const def = this.tools.get(name)
    if (!def) return { error: `工具 "${name}" 不存在` }

    // 1. 前置拦截（策略/审批插件可返回 false 拒绝）
    if (ctx.emit) {
      const allowed = await ctx.emit('tools/before-exec', { name, args })
      if (allowed === false) {
        return { error: `工具 "${name}" 被拦截（tools/before-exec 拒绝执行）` }
      }
    }

    // 2. 沙箱守卫（按工具声明的 guard 自动裁决）
    if (def.sandbox && ctx.sandbox) {
      try {
        if (def.sandbox.commandArg && args[def.sandbox.commandArg] !== undefined) {
          ctx.sandbox.checkCommand(String(args[def.sandbox.commandArg]))
        }
        if (def.sandbox.writeArg && args[def.sandbox.writeArg] !== undefined) {
          ctx.sandbox.checkWrite(String(args[def.sandbox.writeArg]))
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        await ctx.emit?.('tools/after-exec', { name, result: { error }, rejectedBy: 'sandbox' })
        return { error }
      }
    }

    // 3. 执行 + 超时 + 重试
    const timeoutMs = options.timeoutMs ?? 60_000
    const retries = options.retries ?? 0
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await withTimeout(Promise.resolve(def.execute(args, ctx)), timeoutMs)
        const normalized: ToolResult = result ?? { text: '' }
        await ctx.emit?.('tools/after-exec', { name, result: normalized })
        return normalized
      } catch (err) {
        lastError = err
        if (attempt < retries) {
          ctx.logger?.warn(`[tools] 工具 "${name}" 第 ${attempt + 1} 次执行失败，将重试：`, err)
          continue
        }
      }
    }
    const errorResult: ToolResult = {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    }
    await ctx.emit?.('tools/after-exec', { name, result: errorResult, error: true })
    return errorResult
  }
}
