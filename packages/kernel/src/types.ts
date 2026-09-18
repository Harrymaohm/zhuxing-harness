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

/** 插件声明的资源需求。注意：这是经由 harness 边界的治理点，不是进程隔离。 */
export interface PluginPermissions {
  /** 允许读取的路径范围（绝对路径前缀或 glob）。 */
  fsRead?: string[]
  /** 允许写入的路径范围。 */
  fsWrite?: string[]
  /** 允许执行的命令（命令名首词白名单）。 */
  shell?: string[]
  /** 允许访问的网络主机（host 或 host:port）。 */
  net?: string[]
  /** 允许读取的环境变量名。 */
  env?: string[]
}

/**
 * 插件定义的公共字段：函数 / 对象 / 类三种形态共享（`name` 在对象形态下可省略，故此处为可选）。
 *
 * `permissions` 的能力边界（务必按此理解）：它约束的是**经由 harness 边界的资源访问**（经工具注册表
 * 执行的工具调用参数），**不能**阻止插件直接 `import('node:fs')` 等 Node API 绕过——插件是进程内任意
 * JS 代码。真正的分发链路安全边界是**加载前的签名校验**，见 plugin-signature.ts。
 */
export interface PluginBase {
  name?: string
  version?: string
  description?: string
  inject?: string[]
  /** 本插件对外提供服务的名字（含插件名本身的隐式服务）。用于依赖拓扑与环检测。 */
  provides?: string[]
  config?: PluginConfigSchema
  permissions?: PluginPermissions
}

/** 插件定义的三种形态（函数 / 对象 / 类），统一归一化为该结构。 */
export interface PluginDefinition extends PluginBase {
  name: string
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 函数形态插件：导出 `apply` 函数。 */
export interface FunctionPlugin extends PluginBase {
  name: string
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 对象形态插件：默认导出含 apply 的对象。 */
export interface ObjectPlugin extends PluginBase {
  apply: (ctx: import('./context.js').Context) => void | Promise<void>
}

/** 类形态插件：提供服务的类。 */
export interface ClassPlugin {
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly permissions?: PluginPermissions
  static?: unknown
  apply?: (ctx: import('./context.js').Context) => void | Promise<void>
}

/**
 * 插件作用域服务协议：服务可实现该可选钩子，被某插件 `inject` 时返回绑定该插件身份的视图。
 *
 * 用途是**治理**（例如工具注册时记录所属插件，执行时按其声明的 permissions 裁决），**不是隔离**：
 * 插件可直接调用 Node API 绕过任何经此协议实施的检查。
 */
export interface PluginScopedService<T = unknown> {
  forPlugin(pluginId: string, permissions?: PluginPermissions): T
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
