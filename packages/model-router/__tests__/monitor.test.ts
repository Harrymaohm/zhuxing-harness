import { describe, expect, it } from 'vitest'
import { ModelMonitorImpl } from '../src/monitor.js'

function call(modelId: string, ok: boolean, latencyMs: number, tokens = 0) {
  return { modelId, ok, latencyMs, promptTokens: tokens, completionTokens: tokens, estCost: tokens / 1000, ts: Date.now() }
}

describe('实时性能监控', () => {
  it('空数据返回中性指标', () => {
    const monitor = new ModelMonitorImpl()
    const m = monitor.metrics('none')
    expect(m.calls).toBe(0)
    expect(m.successRate).toBe(1)
  })

  it('聚合成功率 / 延迟 / token / 成本', () => {
    const monitor = new ModelMonitorImpl()
    monitor.record(call('a', true, 100, 500))
    monitor.record(call('a', true, 200, 500))
    monitor.record(call('a', false, 300))
    const m = monitor.metrics('a')
    expect(m.calls).toBe(3)
    expect(m.ok).toBe(2)
    expect(m.fail).toBe(1)
    expect(m.successRate).toBeCloseTo(2 / 3)
    expect(m.avgLatencyMs).toBe(200)
    expect(m.totalTokens).toBe(2000)
    expect(m.estCost).toBeCloseTo(1)
  })

  it('聚合前缀缓存命中率', () => {
    const monitor = new ModelMonitorImpl()
    monitor.record({ ...call('a', true, 100), cacheHitTokens: 700, cacheMissTokens: 300 })
    monitor.record({ ...call('a', true, 100), cacheHitTokens: 100, cacheMissTokens: 100 })
    const m = monitor.metrics('a')
    expect(m.totalCacheHitTokens).toBe(800)
    expect(m.totalCacheMissTokens).toBe(400)
    expect(m.cacheHitRate).toBeCloseTo(2 / 3)
  })

  it('无 usage 上报时命中率为 0', () => {
    const monitor = new ModelMonitorImpl()
    monitor.record(call('a', true, 100))
    expect(monitor.metrics('a').cacheHitRate).toBe(0)
  })

  it('p95 取排序后 95 分位', () => {
    const monitor = new ModelMonitorImpl()
    for (let i = 1; i <= 20; i++) monitor.record(call('a', true, i * 10))
    const m = monitor.metrics('a')
    expect(m.p95LatencyMs).toBe(190)
  })

  it('滑动窗口裁剪到最近 N 次', () => {
    const monitor = new ModelMonitorImpl(3)
    for (let i = 1; i <= 5; i++) monitor.record(call('a', true, i))
    const m = monitor.metrics('a')
    expect(m.calls).toBe(3)
  })

  it('all() 返回全部模型快照', () => {
    const monitor = new ModelMonitorImpl()
    monitor.record(call('a', true, 1))
    monitor.record(call('b', false, 2, 100))
    const all = monitor.all()
    expect(Object.keys(all)).toEqual(['a', 'b'])
    expect(all.b.successRate).toBe(0)
  })
})
