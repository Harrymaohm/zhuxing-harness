// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 面板经 apiFetch 打后端：全部换成可编程的 mock，测试不碰真实服务。
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('../src/api', () => ({ apiFetch: apiFetchMock }))

import { MemoryPanel, SkillPanel } from '../src/views/Panels'

/**
 * 搜索防抖行为验收（计划书 P0-3）：
 * 1. 连敲 5 字只发 1 次请求（停敲 300ms 后才出门）；
 * 2. 过期响应丢弃——慢的旧请求晚回来，不能覆盖新结果。
 *
 * 用 fireEvent 而不是 userEvent：后者内部有自己的定时器，
 * 与 fake timers 相性差；防抖只需要 change 事件。
 */

/** 把微任务队列排空（refresh 里 await apiFetch → await res.json() 是多跳微任务）。 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ entries: [], skills: [] }) })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('搜索防抖（记忆面板）', () => {
  it('连敲 5 字只发 1 次请求，且请求带最终关键词', async () => {
    render(<MemoryPanel />)
    // 挂载即发一次初始列表请求
    await act(async () => { await drainMicrotasks() })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText<HTMLInputElement>('关键词')
    const word = '记忆甲乙丙'
    for (let i = 1; i <= word.length; i++) {
      fireEvent.change(input, { target: { value: word.slice(0, i) } })
    }
    // 连敲过程中一次都不许发
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // 停敲 250ms：还没到 300ms 防抖窗口
    act(() => { vi.advanceTimersByTime(250) })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // 满 300ms：只补发 1 次，且关键词是敲完的最终值
    await act(async () => { vi.advanceTimersByTime(100); await drainMicrotasks() })
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    const url = new URL(String(apiFetchMock.mock.calls[1][0]), 'http://virtual.local')
    expect(url.searchParams.get('q')).toBe(word)
  })
})

describe('过期响应丢弃（技能面板）', () => {
  it('慢的旧请求晚回来时，不覆盖新请求的结果', async () => {
    const skill = (name: string) => ({ name, description: `${name} 的描述` })
    let resolveStale: ((v: unknown) => void) | undefined
    apiFetchMock.mockImplementation((url: string) => {
      if (url === `/api/skills?q=${encodeURIComponent('甲')}`) {
        // 第一次搜索：挂住，晚于第二次搜索返回
        return new Promise((resolve) => { resolveStale = resolve })
      }
      if (url === `/api/skills?q=${encodeURIComponent('甲乙')}`) {
        return Promise.resolve({ ok: true, json: async () => ({ skills: [skill('新结果技能')] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ skills: [] }) })
    })

    render(<SkillPanel />)
    await act(async () => { await drainMicrotasks() })

    const input = screen.getByPlaceholderText<HTMLInputElement>('名称/描述关键词')
    // 搜「甲」→ 防抖到期发出（此请求被挂住）
    fireEvent.change(input, { target: { value: '甲' } })
    await act(async () => { vi.advanceTimersByTime(350); await drainMicrotasks() })
    expect(apiFetchMock).toHaveBeenCalledTimes(2)

    // 改搜「甲乙」→ 发出更新的请求并先返回
    fireEvent.change(input, { target: { value: '甲乙' } })
    await act(async () => { vi.advanceTimersByTime(350); await drainMicrotasks() })
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(screen.getByText('新结果技能')).toBeInTheDocument()

    // 此时挂住的旧请求才回来——它携带的结果必须被丢弃
    await act(async () => {
      resolveStale?.({ ok: true, json: async () => ({ skills: [skill('迟到的旧技能')] }) })
      await drainMicrotasks()
    })
    expect(screen.queryByText('迟到的旧技能')).not.toBeInTheDocument()
    expect(screen.getByText('新结果技能')).toBeInTheDocument()
  })
})
