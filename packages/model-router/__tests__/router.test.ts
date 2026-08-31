import { describe, expect, it } from 'vitest'
import { ModelRegistryImpl } from '../src/registry.js'
import { ModelMonitorImpl } from '../src/monitor.js'
import { ModelSelectorImpl } from '../src/selector.js'
import { ModelRouterImpl } from '../src/router.js'
import { ModelOrchestratorImpl } from '../src/orchestrator.js'
import type { ChatProvider } from '@zhuxing/harness-llm'

function fakeProvider(content: string, failTimes = 0): ChatProvider {
  let fails = failTimes
  return {
    name: `fake:${content}`,
    chat: async () => {
      if (fails > 0) {
        fails--
        throw new Error('provider down')
      }
      return { content, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }
    },
    stream: async function* () {
      yield { token: 'hi' }
      yield { done: { content, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } }
    },
  }
}

function setup() {
  const registry = new ModelRegistryImpl()
  const monitor = new ModelMonitorImpl()
  const selector = new ModelSelectorImpl(registry, monitor)
  const router = new ModelRouterImpl(registry, monitor, selector)
  const orchestrator = new ModelOrchestratorImpl(registry, monitor, router)
  return { registry, monitor, selector, router, orchestrator }
}

describe('统一模型交互接口（ModelRouter）', () => {
  it('自动选择并调用子模型，输出统一 ChatResult', async () => {
    const { registry, router } = setup()
    registry.register({ id: 'fast', capabilities: ['fast'] }, fakeProvider('FAST 结果'))
    const result = await router.chat([{ role: 'user', content: '快速回答' }])
    expect(result.content).toBe('FAST 结果')
    expect((result.raw as Record<string, unknown>).__modelId).toBe('fast')
  })

  it('首选失败自动降级到次优模型', async () => {
    const { registry, router } = setup()
    // bad 注册在前（首选），持续失败
    registry.register({ id: 'bad', capabilities: ['fast'] }, fakeProvider('BAD', 99))
    registry.register({ id: 'good', capabilities: ['fast'] }, fakeProvider('GOOD'))
    const auto = await router.chat([{ role: 'user', content: 'x' }], { hints: { task: '快速回答' } })
    expect(auto.content).toBe('GOOD') // 降级成功

    // fallback: false 且显式指定失败模型时只尝试首选，失败直接抛错
    await expect(
      router.chat([{ role: 'user', content: 'x' }], { modelId: 'bad', fallback: false }),
    ).rejects.toThrow(/全部失败/)
  })

  it('显式 modelId 调用', async () => {
    const { registry, router } = setup()
    registry.register({ id: 'm1' }, fakeProvider('M1'))
    registry.register({ id: 'm2' }, fakeProvider('M2'))
    const result = await router.chat([{ role: 'user', content: '任意' }], { modelId: 'm2' })
    expect(result.content).toBe('M2')
  })

  it('全部失败时抛出聚合错误', async () => {
    const { registry, router } = setup()
    registry.register({ id: 'm1' }, fakeProvider('x', 99))
    registry.register({ id: 'm2' }, fakeProvider('y', 99))
    await expect(router.chat([{ role: 'user', content: 'x' }], { fallback: true })).rejects.toThrow(/全部失败/)
  })

  it('无注册模型时报错', async () => {
    const { router } = setup()
    await expect(router.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/无可用子模型/)
  })

  it('流式调用转发 token 并统一 done', async () => {
    const { registry, router } = setup()
    registry.register({ id: 'm' }, fakeProvider('STREAM RESULT'))
    const tokens: string[] = []
    let done: Awaited<ReturnType<ChatProvider['chat']>> | undefined
    for await (const chunk of router.stream([{ role: 'user', content: 'x' }])) {
      if (chunk.token) tokens.push(chunk.token)
      if (chunk.done) done = chunk.done
    }
    expect(tokens).toEqual(['hi'])
    expect(done?.content).toBe('STREAM RESULT')
  })
})

describe('模型间通信协议（Orchestrator）', () => {
  it('delegate 返回统一格式结果', async () => {
    const { registry, orchestrator } = setup()
    registry.register({ id: 'worker', capabilities: ['fast'], costPer1k: 0.01 }, fakeProvider('子模型输出'))
    const result = await orchestrator.delegate({ task: '计算一下', context: '额外上下文' })
    expect(result.ok).toBe(true)
    expect(result.modelId).toBe('worker')
    expect(result.content).toBe('子模型输出')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.usage?.totalTokens).toBe(150)
  })

  it('子任务失败时返回 error 而非抛错', async () => {
    const { registry, orchestrator } = setup()
    registry.register({ id: 'broken' }, fakeProvider('x', 99))
    const result = await orchestrator.delegate({ task: '会失败的任务' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/失败|down/)
  })

  it('listModels 返回模型与实时指标', async () => {
    const { registry, monitor, orchestrator } = setup()
    registry.register({ id: 'm' }, fakeProvider('x'))
    monitor.record({ modelId: 'm', ok: true, latencyMs: 100, ts: Date.now() })
    const list = orchestrator.listModels()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('m')
    expect(list[0].metrics.calls).toBe(1)
    expect(list[0].metrics.successRate).toBe(1)
  })
})
