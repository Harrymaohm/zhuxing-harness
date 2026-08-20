/**
 * 内核核心类型定义。
 */

/** 清理函数：插件卸载时执行，必须幂等。 */
export type Disposer = () => void | Promise<void>

/** 事件监听器。返回 false 可拒绝（reject）事件继续传播。 */
export type EventListener<P = unknown> = (payload: P, eventName: string) => void | boolean | Promise<void | boolean>

/** 插件配置 schema（简化 JSON Schema 子集）。 */
export interface PluginConfigSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  default?: Record<string, unknown>
}

/** 插件定义的三种形态（函数 / 对象 / 类），统一归一化为该结构。 */
export interface PluginDefinition {
  name: string
  version?: string
  description?: string
  inject?: string[]
  /** 本插件对外提供服务的名字（含插件名本身的隐式服务）。用于依赖拓扑与环检测。 */
  provides?: string[]
  config?: PluginConfigSchema
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 函数形态插件：导出 `apply` 函数。 */
export interface FunctionPlugin {
  name: string
  version?: string
  description?: string
  inject?: string[]
  provides?: string[]
  config?: PluginConfigSchema
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 对象形态插件：默认导出含 apply 的对象。 */
export interface ObjectPlugin {
  name?: string
  version?: string
  description?: string
  inject?: string[]
  provides?: string[]
  config?: PluginConfigSchema
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 类形态插件：提供服务的类。 */
export interface ClassPlugin {
  readonly name?: string
  readonly version?: string
  readonly description?: string
  static?: unknown
  apply?: (ctx: import('./context.js').Context) => void | Promise<void>
}

export type PluginModule =
  | FunctionPlugin
  | ObjectPlugin
  | (new (ctx: import('./context.js').Context) => unknown & Partial<ClassPlugin>)

/** 插件运行时状态。 */
export type PluginState = 'mounted' | 'pending' | 'unmounted' | 'disposed'

/** 插件生命周期钩子（对象形态可提供）。 */
export interface PluginLifecycleHooks {
  beforeMount?: () => void | Promise<void>
  afterMount?: () => void | Promise<void>
  beforeDispose?: () => void | Promise<void>
}

/** 服务的运行时记录。 */
export interface ServiceRecord {
  name: string
  impl: unknown
  providerPlugin: string | null
  /** 反向依赖图：消费者插件 id 集合。 */
  consumers: Set<string>
}

/** 轻量日志接口。 */
export interface Logger {
  trace(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}
