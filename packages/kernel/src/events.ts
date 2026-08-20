import type { Disposer, EventListener } from './types.js'

interface ListenerEntry<P = unknown> {
  listener: EventListener<P>
  pluginId: string | null
  once: boolean
  order: number
}

/**
 * 类型化事件总线。
 * - 支持 on / once / off / emit。
 * - 监听器返回 `false` 可拒绝事件继续传播（emit 返回 false），用于 agent/*、tools/* 拦截。
 * - 支持按插件批量移除监听器（插件卸载时自动清理，防 use-after-dispose）。
 */
export class EventBus {
  private listeners = new Map<string, Set<ListenerEntry>>()
  private orderCounter = 0

  on<P = unknown>(event: string, listener: EventListener<P>, pluginId: string | null = null): Disposer {
    const entry: ListenerEntry = { listener: listener as EventListener, pluginId, once: false, order: this.orderCounter++ }
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(entry)
    return () => {
      set.delete(entry)
      if (set.size === 0) this.listeners.delete(event)
    }
  }

  once<P = unknown>(event: string, listener: EventListener<P>, pluginId: string | null = null): Disposer {
    const entry: ListenerEntry = { listener: listener as EventListener, pluginId, once: true, order: this.orderCounter++ }
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(entry)
    return () => {
      set.delete(entry)
      if (set.size === 0) this.listeners.delete(event)
    }
  }

  /** 派发事件。按注册顺序执行；任一监听器返回 false 则停止并返回 false。 */
  async emit(event: string, payload?: unknown): Promise<boolean> {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return true
    const entries = [...set].sort((a, b) => a.order - b.order)
    for (const entry of entries) {
      if (entry.once) set.delete(entry)
      const result = await entry.listener(payload, event)
      if (result === false) return false
    }
    if (set.size === 0) this.listeners.delete(event)
    return true
  }

  /** 移除某插件注册的全部监听器（插件卸载时调用）。 */
  removePluginListeners(pluginId: string): void {
    for (const [event, set] of this.listeners) {
      for (const entry of set) {
        if (entry.pluginId === pluginId) set.delete(entry)
      }
      if (set.size === 0) this.listeners.delete(event)
    }
  }

  /** 当前监听器数量（用于测试/观测）。 */
  get listenerCount(): number {
    let n = 0
    for (const set of this.listeners.values()) n += set.size
    return n
  }
}
