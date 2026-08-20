import { ContextImpl } from './context.js'
import type { ContextImpl as ContextImplType } from './context.js'
import type { Harness, MountOptions, PluginManager, PluginRecord } from './context.js'
import type { ServiceRegistry } from './context.js'
import type { Logger, PluginDefinition, PluginModule, PluginState } from './types.js'

interface PendingEntry {
  def: PluginDefinition
  options?: MountOptions
  missing: Set<string>
  resolve: (record: PluginRecord) => void
  reject: (err: Error) => void
}

const MAX_IN_FLIGHT_WAIT_MS = 5000

/** 归一化插件定义为标准结构。 */
export function normalizePlugin(def: unknown): PluginDefinition {
  if (typeof def === 'function') {
    const fn = def as PluginDefinition
    if (!fn.name) throw new Error('[harness] 函数形态插件必须提供 name 属性')
    return {
      name: fn.name,
      version: fn.version,
      description: fn.description,
      inject: fn.inject,
      provides: fn.provides,
      config: fn.config,
      apply: fn.apply,
    }
  }
  if (typeof def === 'object' && def !== null) {
    const obj = def as PluginDefinition
    if (typeof obj.apply !== 'function') throw new Error('[harness] 插件必须导出 apply(ctx) 函数')
    const name = obj.name ?? (def as { constructor?: { name?: string } }).constructor?.name
    if (!name || name === 'Object') throw new Error('[harness] 对象形态插件必须提供 name')
    return {
      name,
      version: obj.version,
      description: obj.description,
      inject: obj.inject,
      provides: obj.provides,
      config: obj.config,
      apply: obj.apply,
    }
  }
  throw new Error('[harness] 无法识别的插件形态：仅支持函数 / 对象 / 类')
}

/**
 * 插件管理器：插件挂载、卸载、重载，依赖拓扑、级联卸载、循环依赖检测。
 * 这是「一切皆插件」与热插拔的核心。
 */
export class PluginManagerImpl implements PluginManager {
  private plugins = new Map<string, PluginRecord>()
  private pending = new Map<string, PendingEntry>()
  private mountCounter = 0

  constructor(
    private app: Harness,
    private services: ServiceRegistry,
    private logger: Logger,
  ) {}

  /** 挂载插件。依赖未就绪时自动等待（pending），服务就绪后解析。 */
  mount(defInput: PluginModule | PluginDefinition, options?: MountOptions): Promise<PluginRecord> {
    let def: PluginDefinition
    try {
      def = normalizePlugin(defInput)
    } catch (err) {
      return Promise.reject(err)
    }
    if (this.plugins.has(def.name)) {
      return Promise.reject(new Error(`[harness] 插件 "${def.name}" 已挂载，拒绝重复挂载（如为升级请先 unmount）。`))
    }
    const missing = new Set<string>()
    for (const dep of def.inject ?? []) {
      if (!this.services.has(dep)) missing.add(dep)
    }
    if (missing.size > 0) {
      // 依赖未就绪：进入 pending，等待服务注册
      const promise = new Promise<PluginRecord>((resolve, reject) => {
        this.pending.set(def.name, { def, options, missing, resolve, reject })
        this.logger.debug(`[plugin] "${def.name}" 等待依赖就绪：${[...missing].join(', ')}`)
        if (options?.timeoutMs) {
          setTimeout(() => {
            const entry = this.pending.get(def.name)
            if (entry) {
              this.pending.delete(def.name)
              reject(
                new Error(
                  `[harness] 插件 "${def.name}" 等待依赖超时（${options.timeoutMs}ms）：${[...missing].join(', ')}`,
                ),
              )
            }
          }, options.timeoutMs)
        }
      })
      this.resolvePending()
      return promise
    }
    const result = this.applyPlugin(def, options)
    this.resolvePending()
    return result
  }

  /** 卸载插件：级联卸载消费者 → 清理副作用 → 移除服务。幂等。 */
  async unmount(pluginId: string, visited = new Set<string>()): Promise<void> {
    if (visited.has(pluginId)) return
    visited.add(pluginId)
    const record = this.plugins.get(pluginId)
    if (!record) {
      // pending 中的插件直接移除
      const pending = this.pending.get(pluginId)
      if (pending) {
        this.pending.delete(pluginId)
        pending.reject(new Error(`[harness] 插件 "${pluginId}" 在依赖就绪前被卸载。`))
      }
      return
    }
    if (record.state !== 'mounted') return
    this.logger.debug(`[plugin] 卸载 "${pluginId}"`)

    // 1. 级联卸载消费者（消费者先于提供者）
    const consumers = this.services.consumersOfProvider(pluginId)
    for (const consumerId of [...consumers]) {
      if (this.plugins.has(consumerId)) {
        await this.unmount(consumerId, visited)
      }
    }

    // 2. 等待 in-flight 完成（带超时）并清理副作用、移除监听器
    await (record.ctx as ContextImplType).dispose()

    // 3. 移除本插件提供的服务
    this.services.unregisterByProvider(pluginId)

    record.state = 'unmounted'
    this.plugins.delete(pluginId)
    await this.app.events.emit('plugin/unmounted', { id: pluginId })
  }

  /** 重载插件：卸载旧实例后以同一定义重新挂载。默认带 5s 依赖等待超时。 */
  async reload(pluginId: string, options?: MountOptions): Promise<PluginRecord> {
    const record = this.plugins.get(pluginId)
    if (!record) throw new Error(`[harness] 插件 "${pluginId}" 未挂载，无法重载`)
    const def = record.definition
    await this.unmount(pluginId)
    return this.mount(def, { ...options, timeoutMs: options?.timeoutMs ?? 5000 })
  }

  /** 服务注册后调用：解析等待中的插件。 */
  resolvePending(): void {
    if (this.pending.size === 0) return
    let progressed = true
    while (progressed) {
      progressed = false
      for (const [id, entry] of this.pending) {
        const stillMissing = [...entry.missing].filter((d) => !this.services.has(d))
        if (stillMissing.length === 0) {
          this.pending.delete(id)
          this.applyPlugin(entry.def, entry.options).then(entry.resolve).catch(entry.reject)
          progressed = true
          break
        }
      }
    }
    this.detectAndRejectCycles()
  }

  get(pluginId: string): PluginRecord | undefined {
    return this.plugins.get(pluginId)
  }

  list(): PluginRecord[] {
    return [...this.plugins.values()].sort((a, b) => a.mountedAt - b.mountedAt)
  }

  stateOf(pluginId: string): PluginState {
    if (this.pending.has(pluginId)) return 'pending'
    return this.plugins.get(pluginId)?.state ?? 'disposed'
  }

  /** 卸载全部插件（逆序：后挂载的先卸载）。 */
  async disposeAll(): Promise<void> {
    const ids = [...this.plugins.keys()].sort(
      (a, b) => (this.plugins.get(b)!.mountedAt) - (this.plugins.get(a)!.mountedAt),
    )
    for (const id of ids) {
      await this.unmount(id)
    }
    for (const [id, entry] of this.pending) {
      entry.reject(new Error(`[harness] 应用关闭，插件 "${id}" 未完成挂载。`))
      this.pending.delete(id)
    }
  }

  /** 环形依赖检测：仅拒绝「缺失依赖由 pending 内部插件提供且构成环」的插件。 */
  private detectAndRejectCycles(): void {
    if (this.pending.size === 0) return
    // pending 插件可提供的服务集合（插件名 + provides 声明）
    const servicesOf = new Map<string, Set<string>>()
    for (const [id, entry] of this.pending) {
      servicesOf.set(id, new Set([id, ...(entry.def.provides ?? [])]))
    }
    // 服务 -> 提供它的 pending 插件 id（仅用于环检测，取首个）
    const providerOf = new Map<string, string>()
    for (const [id, services] of servicesOf) {
      for (const s of services) providerOf.set(s, id)
    }
    const graph = new Map<string, string[]>()
    for (const [id, entry] of this.pending) {
      const edges: string[] = []
      for (const dep of entry.missing) {
        const provider = providerOf.get(dep)
        if (provider && provider !== id) edges.push(provider)
      }
      graph.set(id, edges)
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const cyclic = new Set<string>()
    const dfs = (id: string, chain: string[]) => {
      if (visiting.has(id)) {
        const start = chain.indexOf(id)
        if (start >= 0) for (const node of chain.slice(start)) cyclic.add(node)
        cyclic.add(id)
        return
      }
      if (visited.has(id)) return
      visiting.add(id)
      for (const dep of graph.get(id) ?? []) dfs(dep, [...chain, id])
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of graph.keys()) {
      if (!visited.has(id)) dfs(id, [])
    }
    for (const id of cyclic) {
      const entry = this.pending.get(id)
      if (entry) {
        this.pending.delete(id)
        entry.reject(new Error(`[harness] 插件 "${id}" 存在循环依赖，已拒绝挂载。`))
      }
    }
  }

  private async applyPlugin(def: PluginDefinition, options?: MountOptions): Promise<PluginRecord> {
    const id = def.name
    this.mountCounter += 1
    const ctx = new ContextImpl(
      this.app,
      id,
      { ...(def.config?.default ?? {}), ...(options?.config ?? {}) },
      this.logger,
    )
    const record: PluginRecord = {
      id,
      definition: def,
      ctx,
      state: 'mounted',
      version: def.version,
      mountedAt: Date.now() + this.mountCounter,
    }
    this.plugins.set(id, record)
    try {
      await def.apply(ctx)
    } catch (err) {
      await ctx.dispose()
      this.plugins.delete(id)
      throw new Error(`[harness] 插件 "${id}" 挂载失败：${err instanceof Error ? err.message : String(err)}`)
    }
    await this.app.events.emit('plugin/mounted', { id })
    return record
  }
}

export { MAX_IN_FLIGHT_WAIT_MS }
