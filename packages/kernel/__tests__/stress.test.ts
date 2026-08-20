import { describe, expect, it } from 'vitest'
import { createHarness } from '../src/app.js'
import type { PluginDefinition } from '../src/types.js'

/** 随机整数 [0, n) */
function rand(n: number): number {
  return Math.floor(Math.random() * n)
}

/**
 * 热插拔压力测试：随机挂载 / 卸载 / 重载 60 轮后，
 * 断言事件总线、服务注册表、插件表全部清空（无资源泄漏 / 悬空引用 / 未清理 effect）。
 */
describe('热插拔压力测试', () => {
  it(
    '随机 mount/unmount/reload 60 轮后无资源泄漏',
    async () => {
    const app = createHarness({ logLevel: 'warn' })
    const pool: PluginDefinition[] = []

    // 服务提供者池（可被卸载/重载，级联影响消费者）
    for (let i = 0; i < 8; i++) {
      const name = `provider-${i}`
      pool.push({
        name,
        provides: [`svc-${i}`],
        apply(ctx) {
          ctx.provide(`svc-${i}`, { id: i })
          // 每个插件都注册事件监听器（卸载时必须被移除）
          ctx.on('ping', () => undefined)
          ctx.effect(() => undefined)
        },
      })
    }
    // 消费者池（随机依赖一个提供者）
    for (let i = 0; i < 12; i++) {
      const dep = rand(8)
      pool.push({
        name: `consumer-${i}`,
        inject: [`svc-${dep}`],
        apply(ctx) {
          ctx.inject(`svc-${dep}`)
          ctx.on('ping', () => undefined)
          ctx.effect(() => undefined)
        },
      })
    }

    const mounted = new Set<string>()
    for (let round = 0; round < 60; round++) {
      const action = rand(3)
      if (action === 0 || mounted.size === 0) {
        // 挂载（跳过已挂载）
        const def = pool[rand(pool.length)]
        if (!mounted.has(def.name) && !app.pluginManager.get(def.name)) {
          try {
            await app.mount(def, { timeoutMs: 300 })
            mounted.add(def.name)
          } catch {
            // 依赖未就绪等预期失败可忽略
          }
        }
      } else if (action === 1) {
        // 卸载已挂载的插件（可能级联卸载消费者）
        const name = [...mounted][rand(mounted.size)]
        try {
          await app.unmount(name)
          mounted.delete(name)
        } catch {
          /* 幂等保护 */
        }
      } else {
        // 重载
        const name = [...mounted][rand(mounted.size)]
        try {
          await app.reload(name, { timeoutMs: 300 })
        } catch {
          /* 重载失败可忽略 */
        }
      }
    }

    // 关闭：卸载全部 + 拒绝残留 pending
    await app.dispose()

    // 断言无泄漏
    expect(app.events.listenerCount).toBe(0)
    expect(app.services.records()).toHaveLength(0)
    expect(app.pluginManager.list()).toHaveLength(0)
    expect([...app.pluginManager.list()]).toHaveLength(0)
    },
    20_000,
  )

  it('连续卸载/重载同一插件 30 次保持稳定', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const def: PluginDefinition = {
      name: 'churn',
      provides: ['churn-svc'],
      apply(ctx) {
        ctx.provide('churn-svc', {})
        ctx.on('ping', () => undefined)
        ctx.effect(() => undefined)
      },
    }
    for (let i = 0; i < 30; i++) {
      await app.mount(def)
      expect(app.pluginManager.stateOf('churn')).toBe('mounted')
      await app.unmount('churn')
      expect(app.pluginManager.stateOf('churn')).toBe('disposed')
      // 服务与监听器随卸载清理
      expect(app.services.has('churn-svc')).toBe(false)
      expect(app.events.listenerCount).toBe(0)
    }
    await app.dispose()
  })
})
