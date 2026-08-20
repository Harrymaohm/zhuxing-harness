import type { ServiceRegistry } from './context.js'
import type { ServiceRecord } from './types.js'

/** Service 注册表实现，维护反向依赖图（consumer -> provider）。 */
export class ServiceRegistryImpl implements ServiceRegistry {
  private services = new Map<string, ServiceRecord>()

  register<T>(name: string, impl: T, providerPlugin: string | null): void {
    if (this.services.has(name)) {
      throw new Error(`[harness] 服务 "${name}" 已被注册（提供者：${this.services.get(name)!.providerPlugin ?? '系统'}），禁止重复注册。`)
    }
    this.services.set(name, { name, impl, providerPlugin, consumers: new Set() })
  }

  unregister(name: string, providerPlugin: string | null): void {
    const rec = this.services.get(name)
    if (rec && rec.providerPlugin === providerPlugin) {
      this.services.delete(name)
    }
  }

  unregisterByProvider(providerPlugin: string): void {
    for (const [name, rec] of this.services) {
      if (rec.providerPlugin === providerPlugin) this.services.delete(name)
    }
  }

  get<T = unknown>(name: string): T | undefined {
    return this.services.get(name)?.impl as T | undefined
  }

  has(name: string): boolean {
    return this.services.has(name)
  }

  registerConsumer(name: string, consumerPluginId: string): void {
    const rec = this.services.get(name)
    // 自己消费自己提供的服务不构成外部依赖，避免级联卸载死循环
    if (rec && rec.providerPlugin !== consumerPluginId) {
      rec.consumers.add(consumerPluginId)
    }
  }

  consumersOfProvider(providerPlugin: string): Set<string> {
    const result = new Set<string>()
    for (const rec of this.services.values()) {
      if (rec.providerPlugin === providerPlugin) {
        for (const c of rec.consumers) result.add(c)
      }
    }
    return result
  }

  records(): ServiceRecord[] {
    return [...this.services.values()]
  }
}
