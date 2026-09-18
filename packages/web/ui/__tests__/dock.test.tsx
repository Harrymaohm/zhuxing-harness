// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// WorkspaceDock 经 useTerminal 间接 import api：测试里不碰真实后端。
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('../src/api', () => ({ apiFetch: apiFetchMock }))

import { TerminalPanel } from '../src/components/TerminalPanel'
import { WorkspaceDock } from '../src/components/WorkspaceDock'
import type { TerminalEntry } from '../src/hooks/useTerminal'
import type { ChatMessage } from '../src/types'

/**
 * 工作区面板（终端 + 预览）行为测试（计划书 P0-4：先补断言再抬门槛）。
 */

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
})

const entry = (over: Partial<TerminalEntry>): TerminalEntry => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  command: 'npm run dev',
  output: '',
  running: false,
  code: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  wallMs: null,
  ...over,
})

describe('TerminalPanel：执行记录的状态摘要', () => {
  const base = { running: false, onRun: vi.fn(), onStop: vi.fn(), onClear: vi.fn() }

  it('每种终止原因都说得清：错误 / 已停止 / 超时 / 退出码+信号+耗时+截断', () => {
    render(
      <TerminalPanel
        {...base}
        entries={[
          entry({ error: '沙箱不允许该命令' }),
          entry({ aborted: true, code: null }),
          entry({ timedOut: true, code: null }),
          entry({ code: 1, signal: 'SIGTERM', wallMs: 2500, truncated: true }),
        ]}
      />,
    )
    expect(screen.getByText('沙箱不允许该命令')).toBeInTheDocument()
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.getByText('超时终止')).toBeInTheDocument()
    expect(screen.getByText('exit 1 · SIGTERM · 2.50s · 输出已截断')).toBeInTheDocument()
  })

  it('成功退出显示 exit 0；无退出码显示占位横线；cwd 取最近一条', () => {
    const { rerender } = render(<TerminalPanel {...base} entries={[entry({ cwd: 'E:/proj/a' })]} />)
    expect(screen.getByText('exit 0')).toBeInTheDocument()
    expect(screen.getByText('E:/proj/a')).toBeInTheDocument()
    rerender(
      <TerminalPanel {...base} entries={[entry({ cwd: 'E:/proj/a' }), entry({ code: null, cwd: 'E:/proj/b' })]} />,
    )
    expect(screen.getByText('exit —')).toBeInTheDocument()
    expect(screen.getByText('E:/proj/b')).toBeInTheDocument()
  })

  it('有输出才有复制按钮；清空/停止按钮点击回调接线正确', async () => {
    const onClear = vi.fn()
    const onStop = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    })
    const { rerender } = render(
      <TerminalPanel
        {...base}
        onStop={onStop}
        onClear={onClear}
        entries={[entry({ output: 'vite ready' }), entry({ command: 'pwd' })]}
      />,
    )
    expect(screen.getByText('vite ready')).toBeInTheDocument()
    const copyBtns = screen.getAllByRole('button', { name: '复制输出' })
    expect(copyBtns).toHaveLength(1) // 无输出的条目不给复制按钮
    fireEvent.click(copyBtns[0])
    await act(async () => {})
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('vite ready')
    fireEvent.click(screen.getByRole('button', { name: /清空/ }))
    expect(onClear).toHaveBeenCalled()
    // 运行中：才出现停止按钮，且清空按钮被禁用
    rerender(
      <TerminalPanel
        running
        onRun={vi.fn()}
        onStop={onStop}
        onClear={onClear}
        entries={[entry({ output: 'vite ready' }), entry({ command: 'pwd' })]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /停止/ }))
    expect(onStop).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /清空/ }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('WorkspaceDock：地址识别与标签切换', () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: `m${Math.random()}`, role: 'assistant', ...over })

  it('识别消息与工具输出里的本机地址：有地址才亮圆点，badge 计数且去重', () => {
    const { container } = render(
      <WorkspaceDock
        messages={[
          msg({ content: '服务已在 http://localhost:5173/ 启动' }),
          msg({ trace: [{ toolResult: 'listening on http://127.0.0.1:4173/' } as never] }),
          msg({ content: '重复地址 http://localhost:5173/' }),
          msg({}), // 无内容的消息直接跳过
        ]}
      />,
    )
    const launcher = screen.getByRole('button', { name: '终端与预览' })
    expect(launcher.querySelector('.xd-dot')).not.toBeNull()
    fireEvent.click(launcher)
    expect(screen.getByRole('complementary', { name: '工作区面板' })).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // 两个去重后的地址
    expect(container.querySelector('.xd-term')).toBeInTheDocument() // 默认停在终端页
  })

  it('切到预览页能看到地址 chip，收起后回到浮钮', () => {
    render(<WorkspaceDock messages={[msg({ content: 'http://localhost:5173/' })]} />)
    fireEvent.click(screen.getByRole('button', { name: '终端与预览' }))
    fireEvent.click(screen.getByRole('button', { name: /预览/ }))
    expect(screen.getAllByText(/localhost:5173/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByRole('button', { name: '终端与预览' })).toBeInTheDocument()
  })

  it('无地址的浮钮不带圆点', () => {
    const { container } = render(<WorkspaceDock messages={[msg({ content: '没有可预览的地址' })]} />)
    expect(container.querySelector('.xd-dot')).toBeNull()
  })
})
