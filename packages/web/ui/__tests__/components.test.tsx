// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 组件会间接 import api（模块级初始化访问令牌）：测试里不碰真实后端。
// 用 vi.hoisted 提升 mock 函数，才能在各用例里按需改写返回值。
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('../src/api', () => ({ apiFetch: apiFetchMock }))

import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { Icon } from '../src/components/Icon'
import { PreviewPanel } from '../src/components/PreviewPanel'
import { TerminalPanel } from '../src/components/TerminalPanel'

/**
 * 无障碍门禁：任何组件测试都可以复用它。
 * 关掉 color-contrast —— jsdom 没有排版引擎，该规则在无样式环境下恒为「不确定」。
 */
async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  // iframes: false —— jsdom 里没有真实的 frame window，axe 扫描 iframe 会直接抛错。
  // 页面内的 iframe 只用于预览本机 dev server，其可访问性由被预览页面自己负责。
  const results = await axe.run(container, { iframes: false, rules: { 'color-contrast': { enabled: false } } })
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
})

describe('ErrorBoundary', () => {
  function Boom(): JSX.Element {
    throw new Error('渲染炸了')
  }

  it('子组件抛错时显示可操作的错误面板，而不是白屏', async () => {
    // React 会把错误同时打到 console.error：这里静音，避免污染测试输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    spy.mockRestore()

    expect(screen.getByText(/界面渲染出错/)).toBeInTheDocument()
    expect(screen.getByText('渲染炸了')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重试渲染/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新加载/ })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('正常渲染时不介入', () => {
    render(
      <ErrorBoundary>
        <p>一切都好</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('一切都好')).toBeInTheDocument()
  })
})

describe('PreviewPanel', () => {
  it('空状态给出可执行的下一步', async () => {
    const { container } = render(<PreviewPanel urls={[]} />)
    expect(screen.getByText(/还没有可预览的内容/)).toBeInTheDocument()
    expect(screen.getByText(/README\.md/)).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('识别到的本机地址以 chip 形式列出，点击即预览', async () => {
    const { container } = render(<PreviewPanel urls={['http://127.0.0.1:5173']} />)
    expect(screen.getByRole('button', { name: '127.0.0.1:5173' })).toBeInTheDocument()
    // 自动跟随最新识别地址
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('http://127.0.0.1:5173')
  })

  it('手动输入应用自身地址被拦下并给出说明，不创建 iframe', async () => {
    const user = userEvent.setup()
    const { container } = render(<PreviewPanel urls={[]} />)
    const input = screen.getByPlaceholderText(/输入本机地址/)
    await user.type(input, 'http://localhost:3000')
    await user.keyboard('{Enter}')

    expect(screen.getByText(/这是应用自身的地址/)).toBeInTheDocument()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('无障碍：地址栏与图标按钮都有可访问名', async () => {
    const { container } = render(<PreviewPanel urls={['http://127.0.0.1:5173']} />)
    await expectNoA11yViolations(container)
  })
})

describe('TerminalPanel', () => {
  const base = { entries: [], running: false, onRun: vi.fn(), onStop: vi.fn(), onClear: vi.fn() }

  it('空状态提示命令会在同一工作区执行', async () => {
    const { container } = render(<TerminalPanel {...base} />)
    expect(screen.getByText(/同一个工作区/)).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('运行中禁止再次提交，并提示可以中断', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<TerminalPanel {...base} running onRun={onRun} />)
    const input = screen.getByPlaceholderText(/命令/)
    expect(input).toBeDisabled()
    await user.type(input, 'echo hi{Enter}')
    expect(onRun).not.toHaveBeenCalled()
  })

  it('回车提交命令并清空输入框', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<TerminalPanel {...base} onRun={onRun} />)
    const input = screen.getByPlaceholderText(/Enter 执行/)
    await user.type(input, 'echo hi{Enter}')
    expect(onRun).toHaveBeenCalledWith('echo hi')
    expect(input).toHaveValue('')
  })

  it('↑ 调出历史、↓ 走回空输入', async () => {
    const user = userEvent.setup()
    render(<TerminalPanel {...base} />)
    const input = screen.getByPlaceholderText(/Enter 执行/)
    await user.type(input, 'first{Enter}')
    await user.type(input, 'second{Enter}')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('second')
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveValue('first')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('second')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveValue('')
  })
})

describe('PreviewPanel 文件模式', () => {
  it('输入工作区路径即读取并渲染文件内容', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ path: 'README.md', content: '# 标题行', size: 6 }),
    })
    render(<PreviewPanel urls={[]} />)
    const input = screen.getByPlaceholderText(/输入本机地址/)
    await user.type(input, 'README.md{Enter}')

    expect(await screen.findByText('# 标题行')).toBeInTheDocument()
    expect(screen.getByText(/6 字节/)).toBeInTheDocument()
    // 读取走的是带认证的预览接口，而不是把路径直接塞进 iframe
    expect(String(apiFetchMock.mock.calls[0][0])).toContain('/api/files/preview?path=README.md')
  })

  it('读取失败时给出可见错误而不是空白', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: '文件不存在' }) })
    render(<PreviewPanel urls={[]} />)
    const input = screen.getByPlaceholderText(/输入本机地址/)
    await user.type(input, 'nope.md{Enter}')

    expect(await screen.findByText(/文件不存在/)).toBeInTheDocument()
  })
})

describe('Icon', () => {
  it('自定义 className 与基础类合并', () => {
    const { container } = render(<Icon name="play" className="extra" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('icon extra')
  })
})
