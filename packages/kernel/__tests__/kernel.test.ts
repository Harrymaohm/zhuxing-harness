import { describe, expect, it, vi } from 'vitest'
import { createHarness } from '../src/app.js'
import type { Context } from '../src/context.js'

describe('插件挂载/卸载', () => {
  it('函数形态插件：apply 执行、effect 逆序清理、dispose 幂等', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const order: string[] = []
    const disposed: string[] = []

    await app.mount({
      name: 'a',
      apply(ctx) {
        order.push('a:apply')
        ctx.effect(() => {
          disposed.push('a:eff1')
          order.push('a:dispose1')
        })
        ctx.effect(() => {
          disposed.push('a:eff2')
          order.push('a:dispose2')
        })
      },
    })
    await app.mount({
      name: 'b',
      apply(ctx) {
        order.push('b:apply')
        ctx.effect(() => {
          disposed.push('b:eff1')
          order.push('b:dispose1')
        })
      },
    })

    expect(order).toEqual(['a:apply', 'b:apply'])
    await app.unmount('a')
    expect(order).toEqual(['a:apply', 'b:apply', 'a:dispose2', 'a:dispose1'])
    expect(disposed).toEqual(['a:eff2', 'a:eff1'])
    await app.unmount('a') // 幂等
    expect(app.pluginManager.stateOf('a')).toBe('disposed')
    await app.dispose()
  })

  it('事件监听器随插件卸载自动移除', async () => {
    const app = createHarness({ logLevel: 'warn' })
    let called = 0
    await app.mount({
      name: 'listener',
      apply(ctx) {
        ctx.on('ping', () => {
          called++
        })
      },
    })
    await app.events.emit('ping')
    expect(called).toBe(1)
    await app.unmount('listener')
    await app.events.emit('ping')
    expect(called).toBe(1)
    expect(app.events.listenerCount).toBe(0)
    await app.dispose()
  })

  it('监听器返回 false 可拒绝事件', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const order: string[] = []
    await app.mount({
      name: 'rejector',
      apply(ctx) {
        ctx.on('check', () => {
          order.push('rejector')
          return false
        })
      },
    })
    await app.mount({
      name: 'after',
      apply(ctx) {
        ctx.on('check', () => {
          order.push('after')
        })
      },
    })
    const result = await app.events.emit('check')
    expect(result).toBe(false)
    expect(order).toEqual(['rejector'])
    await app.dispose()
  })

  it('重复挂载同一插件被拒绝', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const def = { name: 'dup', apply: () => undefined }
    await app.mount(def)
    await expect(app.mount(def)).rejects.toThrow(/已挂载/)
    await app.dispose()
  })

  it('挂载失败自动回滚（清理已注册资源）', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const cleaned: string[] = []
    await expect(
      app.mount({
        name: 'boom',
        apply(ctx) {
          ctx.effect(() => {
            cleaned.push('clean')
          })
          throw new Error('apply 崩溃')
        },
      }),
    ).rejects.toThrow(/apply 崩溃/)
    expect(cleaned).toEqual(['clean'])
    expect(app.pluginManager.stateOf('boom')).toBe('disposed')
    await app.dispose()
  })
})

describe('依赖注入与拓扑', () => {
  it('inject 可注入已注册服务，并登记反向依赖', async () => {
    const app = createHarness({ logLevel: 'warn' })
    await app.mount({
      name: 'provider',
      apply(ctx) {
        ctx.provide('store', { data: 'hello' })
      },
    })
    let got: unknown
    await app.mount({
      name: 'consumer',
      inject: ['store'],
      apply(ctx) {
        got = ctx.inject('store')
      },
    })
    expect(got).toEqual({ data: 'hello' })
    // 反向依赖：provider 的消费者包含 consumer
    expect(app.services.consumersOfProvider('provider')).toContain('consumer')
    await app.dispose()
  })

  it('依赖未就绪时进入 pending，服务注册后自动挂载', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const applied: string[] = []
    const consumerP = app.mount({
      name: 'late-consumer',
      inject: ['late-store'],
      apply(ctx) {
        applied.push('consumer')
        ctx.inject('late-store')
      },
    })
    expect(app.pluginManager.stateOf('late-consumer')).toBe('pending')
    await app.mount({
      name: 'late-provider',
      apply(ctx) {
        ctx.provide('late-store', 42)
      },
    })
    await consumerP
    expect(applied).toEqual(['consumer'])
    expect(app.pluginManager.stateOf('late-consumer')).toBe('mounted')
    await app.dispose()
  })

  it('pending 在超时前解析时，等待定时器必须被清掉', async () => {
    // 用假定时器把「有没有残留定时器」变成确定可数的事实：getTimerCount() 只看假定时器，
    // 不受 vitest 自身真实定时器与并发负载影响（真实定时器计数在高并发下基线会漂移）。
    vi.useFakeTimers()
    try {
      const app = createHarness({ logLevel: 'warn' })
      // 超时给到 10 分钟：解析后若不清，这个定时器会把事件循环占住 10 分钟
      const consumerP = app.mount(
        {
          name: 'timer-consumer',
          inject: ['timer-store'],
          apply(ctx) {
            ctx.inject('timer-store')
          },
        },
        { timeoutMs: 600_000 },
      )
      expect(app.pluginManager.stateOf('timer-consumer')).toBe('pending')
      expect(vi.getTimerCount()).toBe(1)

      await app.mount({
        name: 'timer-provider',
        apply(ctx) {
          ctx.provide('timer-store', 1)
        },
      })
      await consumerP
      expect(app.pluginManager.stateOf('timer-consumer')).toBe('mounted')
      // 关键断言：依赖已就绪、插件已挂载，等待超时定时器不该再活着
      expect(vi.getTimerCount()).toBe(0)
      await app.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('缺失依赖的 pending 在关闭时被拒绝', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const p = app.mount({ name: 'orphan', inject: ['never'], apply: () => undefined })
    await app.dispose()
    await expect(p).rejects.toThrow(/未完成挂载/)
  })

  it('循环依赖被检测并拒绝', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const p1 = app.mount({
      name: 'loop-a',
      provides: ['svc-a'],
      inject: ['svc-b'],
      apply: () => undefined,
    })
    const p2 = app.mount({
      name: 'loop-b',
      provides: ['svc-b'],
      inject: ['svc-a'],
      apply: () => undefined,
    })
    await p1.catch(() => undefined)
    await expect(p2).rejects.toThrow(/循环依赖/)
    expect(app.pluginManager.stateOf('loop-a')).toBe('disposed')
    expect(app.pluginManager.stateOf('loop-b')).toBe('disposed')
    await app.dispose()
  })
})

describe('热插拔', () => {
  it('级联卸载：卸载服务提供者时消费者一并卸载', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const disposed: string[] = []
    await app.mount({
      name: 'provider',
      apply(ctx) {
        ctx.provide('db', {})
      },
    })
    await app.mount({
      name: 'consumer',
      inject: ['db'],
      apply(ctx) {
        ctx.inject('db')
        ctx.effect(() => {
          disposed.push('consumer')
        })
      },
    })
    await app.unmount('provider')
    expect(disposed).toEqual(['consumer'])
    expect(app.pluginManager.stateOf('consumer')).toBe('disposed')
    expect(app.pluginManager.stateOf('provider')).toBe('disposed')
    await app.dispose()
  })

  it('reload 可卸载并以同一定义重新挂载', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const logs: string[] = []
    const def = {
      name: 'hot',
      apply(ctx: Context) {
        ctx.effect(() => {
          logs.push('dispose')
        })
        logs.push('apply')
      },
    }
    await app.mount(def)
    await app.reload('hot')
    expect(logs).toEqual(['apply', 'dispose', 'apply'])
    await app.dispose()
  })

  it('in-flight 操作在卸载时被等待，且立即释放 5s 强断定时器', async () => {
    vi.useFakeTimers()
    try {
      const app = createHarness({ logLevel: 'warn' })
      let done = false
      await app.mount({
        name: 'busy',
        apply(ctx) {
          ctx.track(
            new Promise<void>((resolve) => setTimeout(() => {
              done = true
              resolve()
            }, 50)),
          )
        },
      })
      const unmountP = app.unmount('busy')
      // 放行 in-flight 自己那个 50ms 定时器，但不推进到 5s——推进过去会把泄漏的强断定时器也烧掉，
      // 那样断言就看不见泄漏了
      await vi.advanceTimersByTimeAsync(50)
      await unmountP
      expect(done).toBe(true)
      // 关键断言：in-flight 已落定，等待用的 5s 强断定时器必须同时被清掉，
      // 否则它会继续占住事件循环 5s（CLI 表现为「任务跑完了进程还不退」）。
      expect(vi.getTimerCount()).toBe(0)
      await app.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载后再通过 ctx 注册能力会报错（防 use-after-dispose）', async () => {
    const app = createHarness({ logLevel: 'warn' })
    let ctxRef: Context
    await app.mount({
      name: 'captured',
      apply(ctx) {
        ctxRef = ctx
      },
    })
    await app.unmount('captured')
    expect(() => ctxRef!.on('x', () => undefined)).toThrow(/已卸载/)
    await app.dispose()
  })
})
