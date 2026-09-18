import type { Disposer, EventListener, Logger } from './types.js'

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
 * - **单个监听器抛错不中断派发**：emit 的契约是「派发事件」，不是「把监听器串起来执行」。
 *   否则任何一个订阅者（含遥测这类纯旁路观察者）写错一行，就会穿透成 AgentLoop.run() 的
 *   rejection 把对话打断——这与内核卸载路径逐个 try/catch 隔离 effect 的做法也不一致。
 */
export class EventBus {
  private listeners = new Map<string, Set<ListenerEntry>>()
  private orderCounter = 0

  constructor(private logger?: Logger) {}

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
      let result: void | boolean
      try {
        result = await entry.listener(payload, event)
      } catch (err) {
        // 隔离：跳过这个故障监听器，继续派发给其余监听器；只有显式返回 false 才算拒绝事件。
        this.logger?.error(`[harness] 事件监听器执行失败，已跳过：${event}`, err)
        continue
      }
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
