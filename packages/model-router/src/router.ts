import type { ChatMessage, ChatResult, ChatStreamChunk } from '@zhuxing/harness-llm'
import type { ModelChoice, ModelMonitor, ModelRegistry, ModelRouter, RouterOptions } from './types.js'
import { taskTextFromMessages, ModelSelectorImpl } from './selector.js'

/** 统一模型交互入口：选择子模型 -> 调用 -> 监控埋点 -> 失败降级 -> 一致输出（ChatResult）。 */
export class ModelRouterImpl implements ModelRouter {
  readonly name = 'model-router'
  /** 默认：首选失败时自动降级到次优模型。 */
  private fallback: boolean

  constructor(
    private registry: ModelRegistry,
    private monitor: ModelMonitor,
    private selector: ModelSelectorImpl,
    options: { fallback?: boolean } = {},
  ) {
    this.fallback = options.fallback ?? true
  }

  /** 输出候选排序（基于消息内容，不发起调用）。 */
  async route(messages: ChatMessage[] = [], options: RouterOptions = {}): Promise<ModelChoice[]> {
    return this.selector.select(messages, options.hints ?? { modelId: options.modelId })
  }

  /** 非流式调用：选择子模型执行，失败自动降级，统一返回 ChatResult。 */
  async chat(messages: ChatMessage[], options: RouterOptions = {}): Promise<ChatResult> {
    const candidates = this.pickCandidates(messages, options)
    if (candidates.length === 0) {
      throw new Error('[model-router] 无可用子模型：请先注册模型（registry.register）或检查选择阈值。')
    }

    const budget = this.fallback ? candidates.length : 1
    let lastError: unknown
    for (let i = 0; i < budget; i++) {
      const choice = candidates[i]
      const registered = this.registry.get(choice.modelId)
      if (!registered) continue
      const startedAt = Date.now()
      try {
        const result = await registered.provider.chat(messages, {
          model: options.model,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          tools: options.tools,
          signal: options.signal,
        })
        this.record(choice.modelId, Date.now() - startedAt, result)
        return this.attachModelId(result, choice.modelId)
      } catch (err) {
        lastError = err
        this.monitor.record({
          modelId: choice.modelId,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        })
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`[model-router] 子模型全部失败（尝试 ${budget} 个）：${msg}`)
  }

  /** 流式调用：转发子模型流；流结束时统一返回完整结果。 */
  async *stream(messages: ChatMessage[], options: RouterOptions = {}): AsyncIterable<ChatStreamChunk> {
    const candidates = this.pickCandidates(messages, options)
    if (candidates.length === 0) {
      throw new Error('[model-router] 无可用子模型：请先注册模型（registry.register）或检查选择阈值。')
    }

    let lastError: unknown
    for (let i = 0; i < candidates.length; i++) {
      const choice = candidates[i]
      const registered = this.registry.get(choice.modelId)
      if (!registered) continue
      if (typeof registered.provider.stream !== 'function') {
        // 子模型不支持流式：回退到 chat（保持调用方接口一致）
        const result = await this.chat(messages, { ...options, modelId: choice.modelId })
        yield { token: result.content }
        yield { done: result }
        return
      }
      const startedAt = Date.now()
      try {
        let final: ChatResult | undefined
        for await (const chunk of registered.provider.stream(messages, {
          model: options.model,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          tools: options.tools,
          signal: options.signal,
        })) {
          if (chunk.token) yield { token: chunk.token }
          if (chunk.done) final = chunk.done
        }
        const result = final ?? { content: '', toolCalls: [], finishReason: 'stop' as const }
        this.record(choice.modelId, Date.now() - startedAt, result)
        yield { done: this.attachModelId(result, choice.modelId) }
        return
      } catch (err) {
        lastError = err
        this.monitor.record({
          modelId: choice.modelId,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        })
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`[model-router] 子模型流式调用全部失败：${msg}`)
  }

  /** 选择候选（显式 modelId 或自动评分排序）。 */
  private pickCandidates(messages: ChatMessage[], options: RouterOptions): ModelChoice[] {
    return this.selector.select(messages, {
      ...(options.hints ?? {}),
      modelId: options.modelId ?? options.hints?.modelId,
    })
  }

  /** 监控埋点：计算耗时与成本估算。 */
  private record(modelId: string, latencyMs: number, result: ChatResult): void {
    const spec = this.registry.get(modelId)?.spec
    const promptTokens = result.usage?.promptTokens
    const completionTokens = result.usage?.completionTokens
    const tokens = (promptTokens ?? 0) + (completionTokens ?? 0)
    const costPer1k = spec?.costPer1k ?? 0
    this.monitor.record({
      modelId,
      ok: true,
      latencyMs,
      promptTokens,
      completionTokens,
      estCost: tokens > 0 ? Number(((tokens / 1000) * costPer1k).toFixed(6)) : 0,
      ts: Date.now(),
    })
  }

  /** 在 ChatResult.raw 上附加实际使用的模型 id（统一输出格式的元数据）。 */
  private attachModelId(result: ChatResult, modelId: string): ChatResult {
    return {
      ...result,
      raw: { ...(result.raw as Record<string, unknown> | undefined), __modelId: modelId },
    }
  }
}

export { taskTextFromMessages }
