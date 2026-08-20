import { EventBus } from './events.js'
import type { Disposer, EventListener, Logger, PluginState, ServiceRecord } from './types.js'

/** 插件上下文：插件与内核交互的唯一入口。 */
export interface Context {
  /** 插件唯一 id（即插件 name）。 */
  readonly pluginId: string
  /** 插件配置（由内核注入，只读视图）。 */
  readonly config: Readonly<Record<string, unknown>>
  readonly logger: Logger
  /** 内核应用实例（访问 events / services / pluginManager）。 */
  readonly app: Harness

  /** 注册可逆副作用；插件卸载时逆序自动执行，必须幂等。 */
  effect(disposer: Disposer): void
  /** 订阅事件；插件卸载时自动移除监听器。 */
  on<P = unknown>(event: string, listener: EventListener<P>): Disposer
  /** 订阅一次性事件。 */
  once<P = unknown>(event: string, listener: EventListener<P>): Disposer
  /** 派发事件。 */
  emit(event: string, payload?: unknown): Promise<boolean>
  /** 注册/覆盖一个 Service，供其他插件 inject。 */
  provide<T = unknown>(name: string, impl: T): void
  /** 注入一个 Service；缺失时抛错。 */
  inject<T = unknown>(name: string): T
  /** 可选注入：不存在返回 undefined，不抛错。 */
  injectOptional<T = unknown>(name: string): T | undefined
  /** 登记 in-flight 异步操作；插件卸载时等待其完成（带超时）。 */
  track<T>(promise: Promise<T>): Promise<T>
}

export interface Harness {
  readonly events: EventBus
  readonly services: ServiceRegistry
  readonly logger: Logger
  readonly pluginManager: PluginManager
  /** 由 PluginManager 注入：服务注册后触发 pending 插件解析。 */
  pluginManagerResolvePending?: () => void
}

export interface ServiceRegistry {
  register<T>(name: string, impl: T, providerPlugin: string | null): void
  unregister(name: string, providerPlugin: string | null): void
  /** 移除某插件提供的全部服务（插件卸载时调用）。 */
  unregisterByProvider(providerPlugin: string): void
  get<T = unknown>(name: string): T | undefined
  has(name: string): boolean
  /** 登记消费者（反向依赖图）。 */
  registerConsumer(name: string, consumerPluginId: string): void
  /** 某插件提供服务的全部消费者插件 id。 */
  consumersOfProvider(providerPlugin: string): Set<string>
  records(): ServiceRecord[]
}

/** 插件管理器（热插拔核心），见 plugin-manager.ts。 */
export interface PluginManager {
  mount(def: unknown, options?: MountOptions): Promise<PluginRecord>
  unmount(pluginId: string): Promise<void>
  reload(pluginId: string, options?: MountOptions): Promise<PluginRecord>
  resolvePending(): void
  get(pluginId: string): PluginRecord | undefined
  list(): PluginRecord[]
  stateOf(pluginId: string): PluginState
  disposeAll(): Promise<void>
}

export interface MountOptions {
  config?: Record<string, unknown>
  /** 依赖等待超时（ms）。超时未就绪则挂载失败。 */
  timeoutMs?: number
}

/** 插件运行时记录。 */
export interface PluginRecord {
  id: string
  definition: import('./types.js').PluginDefinition
  ctx: Context
  state: PluginState
  version?: string
  mountedAt: number
}

/** Context 实现：管理插件资源生命周期。 */
export class ContextImpl implements Context {
  readonly app: Harness
  readonly pluginId: string
  readonly config: Readonly<Record<string, unknown>>
  readonly logger: Logger

  disposed = false
  private effects: Disposer[] = []
  private inFlight = new Set<Promise<unknown>>()

  constructor(
    app: Harness,
    pluginId: string,
    config: Record<string, unknown>,
    logger: Logger,
  ) {
    this.app = app
    this.pluginId = pluginId
    this.config = config
    this.logger = logger
  }

  effect(disposer: Disposer): void {
    this.assertAlive()
    this.effects.push(disposer)
  }

  on<P = unknown>(event: string, listener: EventListener<P>): Disposer {
    this.assertAlive()
    return this.app.events.on(event, listener, this.pluginId)
  }

  once<P = unknown>(event: string, listener: EventListener<P>): Disposer {
    this.assertAlive()
    return this.app.events.once(event, listener, this.pluginId)
  }

  emit(event: string, payload?: unknown): Promise<boolean> {
    return this.app.events.emit(event, payload)
  }

  provide<T = unknown>(name: string, impl: T): void {
    this.assertAlive()
    this.app.services.register(name, impl, this.pluginId)
    // 服务注册可能让 pending 插件满足依赖
    void this.app.pluginManagerResolvePending?.()
  }

  inject<T = unknown>(name: string): T {
    this.assertAlive()
    const impl = this.app.services.get<T>(name)
    if (impl === undefined) {
      throw new Error(
        `[harness] 插件 "${this.pluginId}" 依赖的服务 "${name}" 不存在或尚未就绪。` +
          `请先挂载提供该服务的插件，或检查 inject 声明。`,
      )
    }
    this.app.services.registerConsumer(name, this.pluginId)
    return impl
  }

  injectOptional<T = unknown>(name: string): T | undefined {
    this.assertAlive()
    const impl = this.app.services.get<T>(name)
    if (impl === undefined) return undefined
    this.app.services.registerConsumer(name, this.pluginId)
    return impl
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.assertAlive()
    this.inFlight.add(promise)
    promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  /**
   * 卸载本插件时执行清理：
   * 1. 移除本插件注册的全部事件监听器（防 use-after-dispose）。
   * 2. 逆序执行 effects（消费者先于提供者由 PluginManager 保证调用顺序）。
   * 3. 等待 in-flight 操作完成（带超时）。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.app.events.removePluginListeners(this.pluginId)
    for (const fn of [...this.effects].reverse()) {
      try {
        await fn()
      } catch (err) {
        this.logger.error(`[ctx:${this.pluginId}] effect 清理失败：`, err)
      }
    }
    this.effects = []
    await this.waitForInFlight()
  }

  private async waitForInFlight(): Promise<void> {
    if (this.inFlight.size === 0) return
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.logger.warn(
          `[ctx:${this.pluginId}] 有 ${this.inFlight.size} 个 in-flight 操作未在 5s 内完成，已被强制中断。`,
        )
        this.inFlight.clear()
        resolve()
      }, 5000)
    })
    const settle = Promise.allSettled([...this.inFlight]).then(() => undefined)
    await Promise.race([settle, timeout])
    this.inFlight.clear()
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error(`[harness] 插件 "${this.pluginId}" 已卸载，禁止再通过其 Context 注册能力。`)
    }
  }
}
