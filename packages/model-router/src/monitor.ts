import type { ModelCallRecord, ModelMetrics, ModelMonitor } from './types.js'

/** 性能监控实现：保留最近 N 次调用，按需聚合为滑动窗口指标。 */
export class ModelMonitorImpl implements ModelMonitor {
  private history = new Map<string, ModelCallRecord[]>()

  constructor(private windowSize = 100) {}

  record(call: ModelCallRecord): void {
    const list = this.history.get(call.modelId) ?? []
    list.push(call)
    if (list.length > this.windowSize) list.splice(0, list.length - this.windowSize)
    this.history.set(call.modelId, list)
  }

  metrics(modelId: string): ModelMetrics {
    const calls = this.history.get(modelId) ?? []
    if (calls.length === 0) {
      return {
        calls: 0,
        ok: 0,
        fail: 0,
        successRate: 1,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        totalTokens: 0,
        estCost: 0,
        totalCacheHitTokens: 0,
        totalCacheMissTokens: 0,
        cacheHitRate: 0,
      }
    }
    const ok = calls.filter((c) => c.ok).length
    const fail = calls.length - ok
    const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b)
    const avgLatencyMs = latencies.reduce((s, v) => s + v, 0) / latencies.length
    const p95Index = Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * 0.95))
    const lastError = calls.find((c) => !c.ok && c.error)?.error
    const totalCacheHitTokens = calls.reduce((s, c) => s + (c.cacheHitTokens ?? 0), 0)
    const totalCacheMissTokens = calls.reduce((s, c) => s + (c.cacheMissTokens ?? 0), 0)
    const cacheDenom = totalCacheHitTokens + totalCacheMissTokens
    return {
      calls: calls.length,
      ok,
      fail,
      successRate: ok / calls.length,
      avgLatencyMs: Math.round(avgLatencyMs),
      p95LatencyMs: latencies[p95Index],
      totalTokens: calls.reduce((s, c) => s + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0),
      estCost: Number(calls.reduce((s, c) => s + (c.estCost ?? 0), 0).toFixed(6)),
      totalCacheHitTokens,
      totalCacheMissTokens,
      cacheHitRate: cacheDenom > 0 ? Number((totalCacheHitTokens / cacheDenom).toFixed(4)) : 0,
      lastError,
    }
  }

  all(): Record<string, ModelMetrics> {
    const ids = new Set<string>()
    for (const [id] of this.history) ids.add(id)
    const result: Record<string, ModelMetrics> = {}
    for (const id of ids) result[id] = this.metrics(id)
    return result
  }
}
