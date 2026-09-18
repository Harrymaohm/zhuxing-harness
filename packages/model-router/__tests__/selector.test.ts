import { describe, expect, it } from 'vitest'
import { ModelRegistryImpl } from '../src/registry.js'
import { ModelMonitorImpl } from '../src/monitor.js'
import { ModelSelectorImpl } from '../src/selector.js'
import type { ChatProvider } from '@zhuxing/harness-llm'

function fakeProvider(): ChatProvider {
  return { name: 'fake', chat: async () => ({ content: '', toolCalls: [], finishReason: 'stop' }) }
}

function setup() {
  const registry = new ModelRegistryImpl()
  const monitor = new ModelMonitorImpl()
  registry.register({ id: 'fast', capabilities: ['fast', 'general'], contextWindow: 8000 }, fakeProvider())
  registry.register({ id: 'reasoner', capabilities: ['reasoning', 'code'], contextWindow: 64_000 }, fakeProvider())
  registry.register({ id: 'long', capabilities: ['analysis', 'long-context'], contextWindow: 200_000 }, fakeProvider())
  const selector = new ModelSelectorImpl(registry, monitor)
  return { registry, monitor, selector }
}

describe('模型选择算法', () => {
  it('任务需求分析：代码任务优先 code 能力模型', () => {
    const { selector } = setup()
    const choices = selector.select([{ role: 'user', content: '帮我写一个 TypeScript 函数并调试 bug' }])
    expect(choices[0].modelId).toBe('reasoner')
  })

  it('长文档任务优先 long-context 模型', () => {
    const { selector } = setup()
    const choices = selector.select([{ role: 'user', content: '请总结整个仓库的全部文件与长文档内容' }])
    expect(choices[0].modelId).toBe('long')
  })

  it('显式 modelId 置顶且不参与评分', () => {
    const { selector } = setup()
    const choices = selector.select([{ role: 'user', content: '写代码' }], { modelId: 'fast' })
    expect(choices).toHaveLength(1)
    expect(choices[0].modelId).toBe('fast')
  })

  it('能力偏好影响排序', () => {
    const { selector } = setup()
    const choices = selector.select([{ role: 'user', content: '随便写点' }], { capabilities: ['code'] })
    expect(choices[0].modelId).toBe('reasoner')
  })

  it('性能指标影响排序：失败率高者降权', () => {
    const { monitor, selector } = setup()
    // 给 fast 造一堆失败
    for (let i = 0; i < 10; i++) {
      monitor.record({ modelId: 'fast', ok: false, latencyMs: 100, ts: Date.now() })
    }
    const choices = selector.select([{ role: 'user', content: '一个不需要特定能力的一般任务' }])
    const fast = choices.find((c) => c.modelId === 'fast')
    expect(fast).toBeDefined()
    expect(fast!.breakdown.performance).toBeLessThan(0.6)
  })

  it('候选按分数降序且过滤低于阈值的', () => {
    const { selector } = setup()
    const choices = selector.select([{ role: 'user', content: '一个完全无关的闲聊话题' }])
    for (let i = 1; i < choices.length; i++) {
      expect(choices[i - 1].score).toBeGreaterThanOrEqual(choices[i].score)
    }
  })

  it('空注册表返回空候选', () => {
    const selector = new ModelSelectorImpl(new ModelRegistryImpl(), new ModelMonitorImpl())
    expect(selector.select([{ role: 'user', content: 'x' }])).toEqual([])
  })

  it('上下文超出窗口时 penalize（long-context 模型优先）', () => {
    const { selector } = setup()
    const longText = '长文档内容 '.repeat(10_000) // ~6 万字符 → 远超 8k 窗口
    const choices = selector.select([{ role: 'user', content: `总结：${longText}` }])
    // 窗口 200k 的 long 模型优先于窗口 8k 的 fast 模型
    expect(choices[0].modelId).toBe('long')
    const fastIdx = choices.findIndex((c) => c.modelId === 'fast')
    const longIdx = choices.findIndex((c) => c.modelId === 'long')
    expect(fastIdx).toBeGreaterThan(longIdx)
  })
})
