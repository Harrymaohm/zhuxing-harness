// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAM_THINK_FLUSH_MS, STREAM_TOKEN_FLUSH_MS, StreamBuffer, type PatchAssistant } from '../src/lib/stream-buffer'
import type { ChatMessage } from '../src/types'

/**
 * 流式缓冲的行为测试 + 优化效果的**量化**验证。
 *
 * 这段逻辑此前写在 2400 行的 App.tsx 里，因为无法单测，「每个 token 触发一次全量渲染」
 * 这类回归没有任何测试拦得住。搬出来之后可以用假定时器把「N 个 token 触发多少次写回」
 * 变成确定的数字。
 */

/** 记录每次写回的补丁，同时统计次数。 */
function makePatch(initial: ChatMessage): { patch: PatchAssistant; calls: () => number; msg: () => ChatMessage } {
  let msg = initial
  let calls = 0
  const patch: PatchAssistant = (fn) => {
    calls += 1
    msg = fn(msg)
  }
  return { patch, calls: () => calls, msg: () => msg }
}

const ASSISTANT: ChatMessage = { id: 'a1', role: 'assistant', content: '' }

describe('流式缓冲（正文/思考的合并窗口）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('正文按合并窗口批量上屏：2000 个 token 不再触发 2000 次写回', async () => {
    vi.useFakeTimers()
    const { patch, calls, msg } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    // 模拟模型以 ~200 token/s 连续吐字，持续 2000 个 token（10 秒）
    const TOTAL = 2000
    for (let i = 0; i < TOTAL; i++) {
      buf.pushToken('字', patch)
      await vi.advanceTimersByTimeAsync(5)
    }
    buf.flushTokens(patch)

    // 关键断言一：一个都不能丢——合并只是推迟写回，不是丢弃
    expect(msg().content).toHaveLength(TOTAL)

    // 关键断言二：写回次数被窗口压制。实测：2000 个 token（每 5ms 一个）只触发 167 次写回，
    // 相比逐 token 写回少 12 倍。这里用区间卡住——上限 1/8 挡住「退化成逐 token 写回」，
    // 下限挡住「攒到最后一次性放出」（那样打字机效果就没了）。
    expect(calls()).toBeLessThan(TOTAL / 8)
    expect(calls()).toBeGreaterThan(TOTAL / 30)
  })

  it('思考走更粗的窗口（用户看不见，不必按正文的频率渲染）', async () => {
    vi.useFakeTimers()
    const { patch, calls } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    for (let i = 0; i < 100; i++) {
      buf.pushThinking('思', patch)
      await vi.advanceTimersByTimeAsync(5)
    }
    buf.flushThinking(patch)

    // 500ms 的思考量，按 150ms 窗口 ⇒ 约 4 次
    expect(calls()).toBeLessThanOrEqual(Math.ceil(500 / STREAM_THINK_FLUSH_MS) + 1)
    expect(calls()).toBeGreaterThan(0)
  })

  it('curContent 同步累积：不等定时器，撤回判定才拿得到完整本步正文', () => {
    vi.useFakeTimers()
    const { patch } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    buf.pushToken('先读文件', patch)
    // 还没到窗口时间：上屏缓冲里压着，但 curContent 必须已经是完整的
    expect(buf.curContent).toBe('先读文件')
    expect(buf.takeCurContent()).toBe('先读文件')
    // 取走后本步缓冲清空，避免被下一步重复撤回
    expect(buf.curContent).toBe('')
  })

  it('flush 会把未到点的增量立刻写出（收尾/异常路径不丢字）', () => {
    vi.useFakeTimers()
    const { patch, msg } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    buf.pushToken('最后一段', patch)
    expect(msg().content).toBe('') // 尚未到窗口
    buf.flushTokens(patch)
    expect(msg().content).toBe('最后一段')
  })

  it('flush 之后到点的定时器不会重复写一次（清句柄，避免内容翻倍）', async () => {
    vi.useFakeTimers()
    const { patch, calls, msg } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    buf.pushToken('abc', patch)
    buf.flushTokens(patch)
    expect(msg().content).toBe('abc')

    await vi.advanceTimersByTimeAsync(STREAM_TOKEN_FLUSH_MS * 2)
    expect(msg().content).toBe('abc')
    expect(calls()).toBe(1)
  })

  it('nextStep 只清本步正文缓冲，不影响已上屏内容', () => {
    vi.useFakeTimers()
    const { patch, msg } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    buf.pushToken('第一步', patch)
    buf.flushTokens(patch)
    buf.nextStep()

    expect(buf.curContent).toBe('')
    expect(msg().content).toBe('第一步')
  })

  it('空增量不产生多余的写回（避免无谓渲染）', () => {
    const { patch, calls } = makePatch(ASSISTANT)
    const buf = new StreamBuffer()

    buf.flushTokens(patch)
    buf.flushThinking(patch)
    expect(calls()).toBe(0)
  })
})
