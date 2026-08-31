import type { ModelRegistry, ModelSpec, RegisteredModel } from './types.js'

/** 模型注册表实现：支持运行期注册/注销（热插拔），同一 id 禁止重复注册。 */
export class ModelRegistryImpl implements ModelRegistry {
  private models = new Map<string, RegisteredModel>()

  register(spec: ModelSpec, provider: RegisteredModel['provider']): () => void {
    if (!spec.id) throw new Error('[model-registry] 模型 id 不能为空')
    if (this.models.has(spec.id)) {
      throw new Error(`[model-registry] 模型 "${spec.id}" 已注册，禁止重复注册。`)
    }
    const record: RegisteredModel = {
      spec: { ...spec, capabilities: spec.capabilities ?? ['general'] },
      provider,
      registeredAt: Date.now(),
    }
    this.models.set(spec.id, record)
    return () => this.unregister(spec.id)
  }

  unregister(modelId: string): void {
    this.models.delete(modelId)
  }

  get(modelId: string): RegisteredModel | undefined {
    return this.models.get(modelId)
  }

  list(): RegisteredModel[] {
    return [...this.models.values()].sort((a, b) => a.registeredAt - b.registeredAt)
  }

  has(modelId: string): boolean {
    return this.models.has(modelId)
  }
}
