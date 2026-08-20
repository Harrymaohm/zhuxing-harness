export { HarnessImpl, createHarness } from './app.js'
export type { HarnessOptions } from './app.js'
export { ContextImpl } from './context.js'
export type { Context, Harness, ServiceRegistry, PluginManager, MountOptions, PluginRecord } from './context.js'
export { EventBus } from './events.js'
export { HarnessError, maskSecrets } from './errors.js'
export type { HarnessErrorCode } from './errors.js'
export { ConsoleLogger, createLogger } from './logger.js'
export type { LogLevel } from './logger.js'
export { PluginManagerImpl, normalizePlugin } from './plugin-manager.js'
export { ServiceRegistryImpl } from './services.js'
export type {
  Disposer,
  EventListener,
  Logger,
  PluginConfigSchema,
  PluginDefinition,
  FunctionPlugin,
  ObjectPlugin,
  ClassPlugin,
  PluginModule,
  PluginState,
  PluginLifecycleHooks,
  ServiceRecord,
} from './types.js'
