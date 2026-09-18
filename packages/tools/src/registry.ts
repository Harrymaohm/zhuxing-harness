import type { ChatTool } from '@zhuxing/harness-llm'
import type { PluginPermissions } from '@zhuxing/harness-kernel'
import type { ToolDefinition, ToolExecuteContext, ToolExecuteOptions, ToolRegistry, ToolResult } from './types.js'
import { withTimeout } from './types.js'
import { checkPluginPermissions } from './permissions.js'

/** 工具归属：注册它的插件 id 与该插件声明的权限清单（仅声明了 permissions 的插件会入表）。 */
interface ToolOwner {
  pluginId: string
  permissions?: PluginPermissions
}

/**
 * 工具注册表实现：注册 + 统一执行管道（拦截 → 插件权限裁决 → 沙箱守卫 → 超时重试 → 结果规范化）。
 *
 * `forPlugin` 是 PluginScopedService 协议入口：`ctx.inject('tools')` 会拿到绑定插件身份的视图，
 * 注册时即可记录归属，执行时才能按该插件声明的 permissions 裁决。**必须清楚这只是治理点**：
 * 插件仍可直接调用 node:fs / child_process 绕过（插件是进程内任意 JS）。
 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private owners = new Map<string, ToolOwner>()

  register(def: ToolDefinition): () => void {
    return this.registerOwned(def)
  }

  /** 供 PluginScopedService 视图调用：登记工具归属，执行时按其权限清单裁决。 */
  registerOwned(def: ToolDefinition, owner?: ToolOwner): () => void {
    if (this.tools.has(def.name)) {
      throw new Error(`[tools] 工具 "${def.name}" 已注册，禁止重复注册。`)
    }
    this.tools.set(def.name, def)
    if (owner) this.owners.set(def.name, owner)
    return () => this.unregister(def.name)
  }

  /** PluginScopedService：返回绑定该插件身份与权限声明的视图。 */
  forPlugin(pluginId: string, permissions?: PluginPermissions): ToolRegistry {
    return new ScopedToolRegistry(this, { pluginId, permissions })
  }

  unregister(name: string): void {
    this.tools.delete(name)
    this.owners.delete(name)
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
    // 执行耗时由本处（唯一执行点）统一测量，随 tools/after-exec 事件派发。
    const startedAt = Date.now()
    const def = this.tools.get(name)
    if (!def) {
      const error = `工具 "${name}" 不存在`
      // 未知工具也必须留审计事件：「调用被尝试过」这一事实本身可观测，不得静默吞掉。
      await ctx.emit?.('tools/after-exec', {
        name,
        result: { error },
        unknownTool: true,
        sessionId: ctx.sessionId,
        callId: ctx.callId,
        durationMs: Date.now() - startedAt,
        ok: false,
      })
      return { error }
    }

    // 1. 前置拦截（策略/审批插件可返回 false 拒绝）
    if (ctx.emit) {
      const allowed = await ctx.emit('tools/before-exec', { name, args, sessionId: ctx.sessionId, callId: ctx.callId })
      if (allowed === false) {
        const error = `工具 "${name}" 被拦截（tools/before-exec 拒绝执行）`
        // 拦截同样是可审计事实：记录裁决结果与来源，便于事后核对「谁在何时挡住了什么」。
        await ctx.emit('tools/after-exec', {
          name,
          result: { error },
          rejectedBy: 'policy',
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          ok: false,
        })
        return { error }
      }
    }

    // 2. 插件权限清单（治理点：只约束经本注册表执行的参数，不是隔离——插件可直接调 Node API 绕过）
    //    未声明 permissions 的插件（内建/仓内插件、既有测试）在此完全不受影响，行为与改动前一致。
    const owner = this.owners.get(name)
    if (owner?.permissions) {
      const violation = checkPluginPermissions(name, def, args, owner.permissions, owner.pluginId)
      if (violation) {
        // 拒绝必须可审计且可读：沿用既有的 tools/after-exec 事件，不新造事件通道。
        ctx.logger?.warn(`[tools] ${violation}`)
        await ctx.emit?.('tools/after-exec', {
          name,
          args,
          result: { error: violation },
          rejectedBy: 'plugin-permissions',
          pluginId: owner.pluginId,
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          ok: false,
        })
        return { error: violation }
      }
    }

    // 3. 沙箱守卫（按工具声明的 guard 自动裁决）
    if (def.sandbox && ctx.sandbox) {
      try {
        if (def.sandbox.commandArg && args[def.sandbox.commandArg] !== undefined) {
          ctx.sandbox.checkCommand(String(args[def.sandbox.commandArg]))
        }
        if (def.sandbox.readArg && args[def.sandbox.readArg] !== undefined) {
          ctx.sandbox.checkRead(String(args[def.sandbox.readArg]))
        }
        if (def.sandbox.writeArg && args[def.sandbox.writeArg] !== undefined) {
          ctx.sandbox.checkWrite(String(args[def.sandbox.writeArg]))
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        await ctx.emit?.('tools/after-exec', {
          name,
          result: { error },
          rejectedBy: 'sandbox',
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          ok: false,
        })
        return { error }
      }
    }

    // 4. 执行 + 超时 + 重试（调用方 options 优先，其次工具自身声明，最后默认 60s）
    const timeoutMs = options.timeoutMs ?? def.timeoutMs ?? 60_000
    const retries = options.retries ?? 0
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await withTimeout(Promise.resolve(def.execute(args, ctx)), timeoutMs)
        const normalized: ToolResult = result ?? { text: '' }
        // ok 是显式成败判定（工具返回 error 字段即为失败），供消费方不必再猜 result 形状。
        await ctx.emit?.('tools/after-exec', {
          name,
          result: normalized,
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          durationMs: Date.now() - startedAt,
          ok: normalized.error === undefined,
        })
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
    await ctx.emit?.('tools/after-exec', {
      name,
      result: errorResult,
      error: true,
      sessionId: ctx.sessionId,
      callId: ctx.callId,
      durationMs: Date.now() - startedAt,
      ok: false,
    })
    return errorResult
  }
}

/**
 * 绑定插件身份的工具注册表视图（由 `ctx.inject('tools')` 通过 PluginScopedService 得到）。
 * 只有 `register` 会带上归属信息，其余方法原样委托——不存在「换个视图就能绕过权限」的说法，
 * 因为绕过权限从来不需要换视图：插件直接调 Node API 即可（治理非隔离）。
 */
class ScopedToolRegistry implements ToolRegistry {
  constructor(
    private inner: ToolRegistryImpl,
    private owner: ToolOwner,
  ) {}

  register(def: ToolDefinition): () => void {
    return this.inner.registerOwned(def, this.owner)
  }

  unregister(name: string): void {
    this.inner.unregister(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.inner.get(name)
  }

  list(): ToolDefinition[] {
    return this.inner.list()
  }

  toChatTools(): ChatTool[] {
    return this.inner.toChatTools()
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecuteContext,
    options?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    return this.inner.execute(name, args, ctx, options)
  }
}
