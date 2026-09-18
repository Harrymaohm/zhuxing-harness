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
export {
  PLUGIN_SIGNATURE_FILE,
  PLUGIN_SIGNATURE_FORMAT,
  computePluginDirDigest,
  findPluginRoot,
  fingerprintPublicKey,
  generatePluginKeyPair,
  harnessConfigPath,
  keyringFromConfig,
  keyringFromEnv,
  parseKeyring,
  resetPluginTrustNotice,
  resolvePluginKeyring,
  signPluginDir,
  verifyPluginDir,
  verifyPluginEntryFile,
} from './plugin-signature.js'
export type {
  PluginSignatureFile,
  PluginTrustDecision,
  PluginTrustOptions,
  PluginTrustStatus,
  PluginKeyPair,
  TrustedKey,
} from './plugin-signature.js'
export type {
  Disposer,
  EventListener,
  Logger,
  PluginBase,
  PluginConfigSchema,
  PluginDefinition,
  FunctionPlugin,
  ObjectPlugin,
  ClassPlugin,
  PluginModule,
  PluginPermissions,
  PluginScopedService,
  PluginState,
  PluginLifecycleHooks,
  ServiceRecord,
} from './types.js'
