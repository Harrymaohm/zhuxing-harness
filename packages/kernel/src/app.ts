import type { Harness, MountOptions, PluginManager, PluginRecord } from './context.js'
import { EventBus } from './events.js'
import { createLogger } from './logger.js'
import type { Logger, PluginDefinition, PluginModule } from './types.js'
import { PluginManagerImpl } from './plugin-manager.js'
import { ServiceRegistryImpl } from './services.js'

export interface HarnessOptions {
  logger?: Logger
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
}

/** Harness 应用：内核的组装入口。 */
export class HarnessImpl implements Harness {
  readonly events: EventBus
  readonly services = new ServiceRegistryImpl()
  readonly pluginManager: PluginManager
  readonly logger: Logger
  readonly startedAt = Date.now()

  constructor(options: HarnessOptions = {}) {
    this.logger = options.logger ?? createLogger('harness', options.logLevel)
    // 事件总线在构造体内初始化（而非字段初始化）：它需要 logger，才能在某个监听器抛错被跳过时留下痕迹，
    // 否则故障会被静默吞掉——「不中断主链路」的前提是「不掩盖故障」。
    this.events = new EventBus(this.logger)
    this.pluginManager = new PluginManagerImpl(this, this.services, this.logger)
    this.pluginManagerResolvePending = () => this.pluginManager.resolvePending()
  }

  pluginManagerResolvePending: (() => void) | undefined

  /**
   * 挂载插件（便捷入口）。
   *
   * 参数类型必须与 PluginManager 保持一致：这里曾写成 `def: unknown` + `{ config? }`，
   * 把类型信息丢光了——于是所有调用方的 `apply(ctx)` 退化成隐式 any，`timeoutMs`
   * 这类正当选项也被类型挡在门外，而测试文件又不在 tsc 的 include 里，
   * 结果是一整片类型错误长期无人发现。便捷入口不该以牺牲类型为代价。
   */
  mount(def: PluginModule | PluginDefinition, options?: MountOptions): Promise<PluginRecord> {
    return this.pluginManager.mount(def, options)
  }

  /** 卸载插件（便捷入口）。 */
  unmount(pluginId: string): Promise<void> {
    return this.pluginManager.unmount(pluginId)
  }

  /** 重载插件（便捷入口）。 */
  reload(pluginId: string, options?: MountOptions): Promise<PluginRecord> {
    return this.pluginManager.reload(pluginId, options)
  }

  /** 关闭应用：卸载全部插件。 */
  async dispose(): Promise<void> {
    await this.pluginManager.disposeAll()
  }
}

/** 创建 Harness 应用。 */
export function createHarness(options: HarnessOptions = {}): HarnessImpl {
  return new HarnessImpl(options)
}
