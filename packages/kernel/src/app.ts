import type { Harness, PluginManager } from './context.js'
import { EventBus } from './events.js'
import { createLogger } from './logger.js'
import type { Logger } from './types.js'
import { PluginManagerImpl } from './plugin-manager.js'
import { ServiceRegistryImpl } from './services.js'

export interface HarnessOptions {
  logger?: Logger
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
}

/** Harness 应用：内核的组装入口。 */
export class HarnessImpl implements Harness {
  readonly events = new EventBus()
  readonly services = new ServiceRegistryImpl()
  readonly pluginManager: PluginManager
  readonly logger: Logger
  readonly startedAt = Date.now()

  constructor(options: HarnessOptions = {}) {
    this.logger = options.logger ?? createLogger('harness', options.logLevel)
    this.pluginManager = new PluginManagerImpl(this, this.services, this.logger)
    this.pluginManagerResolvePending = () => this.pluginManager.resolvePending()
  }

  pluginManagerResolvePending: (() => void) | undefined

  /** 挂载插件（便捷入口）。 */
  mount(def: unknown, options?: { config?: Record<string, unknown> }): Promise<import('./context.js').PluginRecord> {
    return this.pluginManager.mount(def, options)
  }

  /** 卸载插件（便捷入口）。 */
  unmount(pluginId: string): Promise<void> {
    return this.pluginManager.unmount(pluginId)
  }

  /** 重载插件（便捷入口）。 */
  reload(pluginId: string, options?: { config?: Record<string, unknown> }): Promise<import('./context.js').PluginRecord> {
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
