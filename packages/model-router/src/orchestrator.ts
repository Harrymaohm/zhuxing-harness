import type { ChatMessage } from '@zhuxing/harness-llm'
import type { ModelMonitor, ModelOrchestrator, ModelRegistry, ModelRouter, ModelTaskRequest, ModelTaskResult } from './types.js'

/** 编排服务实现：主编排模型 -> 选择子模型 -> 委派子任务 -> 统一结果（模型间通信协议）。 */
export class ModelOrchestratorImpl implements ModelOrchestrator {
  constructor(
    private registry: ModelRegistry,
    private monitor: ModelMonitor,
    private router: ModelRouter,
  ) {}

  async delegate(req: ModelTaskRequest): Promise<ModelTaskResult> {
    const startedAt = Date.now()
    // 自动委派时主模型不应成为候选（派给自己是无效调用）；显式指定 modelId 时尊重用户意图。
    if (!req.hints?.modelId && !this.registry.list().some((m) => m.spec.id !== 'default')) {
      return {
        ok: false,
        modelId: 'none',
        content: '',
        latencyMs: 0,
        error: '没有可用的子模型：当前仅注册了主模型。请先在配置中添加子模型（config.models 或 token-plan 文本子模型）后再委派。',
      }
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是筑星 Harness 的子模型。请直接完成用户子任务，输出简洁、结构化的最终结果。' },
      { role: 'user', content: req.context ? `${req.task}\n\n附加上下文：\n${req.context}` : req.task },
    ]
    try {
      const result = await this.router.chat(messages, {
        modelId: req.hints?.modelId,
        hints: { task: req.task, capabilities: req.hints?.capabilities },
        maxTokens: req.hints?.maxTokens,
        temperature: req.hints?.temperature,
        excludeModelIds: req.hints?.modelId ? undefined : ['default'],
      })
      const modelId = (result.raw as Record<string, unknown> | undefined)?.__modelId as string | undefined
      return {
        ok: true,
        modelId: modelId ?? 'unknown',
        content: result.content,
        usage: result.usage,
        latencyMs: Date.now() - startedAt,
        estCost: modelId ? this.monitor.metrics(modelId).estCost : 0,
      }
    } catch (err) {
      return {
        ok: false,
        modelId: req.hints?.modelId ?? 'unknown',
        content: '',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  listModels() {
    return this.registry.list().map(({ spec }) => ({
      id: spec.id,
      label: spec.label ?? spec.id,
      capabilities: spec.capabilities ?? [],
      contextWindow: spec.contextWindow,
      metrics: this.monitor.metrics(spec.id),
    }))
  }
}
