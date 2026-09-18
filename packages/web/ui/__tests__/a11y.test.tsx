// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'

// 组件会间接 import api（模块级初始化访问令牌）：测试里不碰真实后端
vi.mock('../src/api', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  initAccessToken: vi.fn(async () => {}),
  versionMismatch: vi.fn(() => null),
}))

import { versionMismatch } from '../src/api'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { FOLD_BLOCK_LIMIT, Markdown } from '../src/components/markdown'
import { VersionBanner } from '../src/components/VersionBanner'
import { WorkspaceDock } from '../src/components/WorkspaceDock'
import { useModalA11y } from '../src/hooks/useModalA11y'

/** 无障碍门禁：关掉 color-contrast（jsdom 没有排版引擎）与 iframes（jsdom 里没有 frame window）。 */
async function expectNoA11yViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, { iframes: false, rules: { 'color-contrast': { enabled: false } } })
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
}

/** 最小弹窗：容器带 tabIndex={-1}，与 App 里的用法一致。 */
function Modal({ children }: { children?: ReactNode }) {
  const ref = useModalA11y(true, () => {})
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="测试弹窗" tabIndex={-1}>
      {children}
    </div>
  )
}

describe('useModalA11y 焦点陷阱', () => {
  it('Tab 在弹窗内循环，不会跑到背后的按钮上', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button>背后的按钮</button>
        <Modal>
          <button>第一个</button>
          <button>第二个</button>
        </Modal>
      </>,
    )

    // 打开时焦点先落在容器上
    expect(screen.getByRole('dialog')).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: '第一个' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '第二个' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '第一个' })).toHaveFocus()

    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: '第二个' })).toHaveFocus()
  })

  it('弹窗内没有任何可聚焦元素时把 Tab 收在容器上，不抛错', async () => {
    const user = userEvent.setup()
    render(
      <Modal>
        <p>纯文本弹窗</p>
      </Modal>,
    )

    await user.tab()
    expect(screen.getByRole('dialog')).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('dialog')).toHaveFocus()
  })
})

describe('折叠交互语义', () => {
  it('Markdown 折叠是可聚焦按钮，带 aria-expanded 与明确的展开/收起文案', async () => {
    const user = userEvent.setup()
    const text = Array.from({ length: FOLD_BLOCK_LIMIT + 2 }, (_, i) => `第 ${i} 段`).join('\n\n')
    render(<Markdown text={text} onPreview={() => {}} foldLimit={FOLD_BLOCK_LIMIT} />)

    const toggle = screen.getByRole('button', { name: /展开/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('收起')
  })

  it('ErrorBoundary 的技术细节是按钮而不是 details，展开状态由 aria-expanded 表达', async () => {
    const user = userEvent.setup()
    function Boom(): JSX.Element {
      throw new Error('渲染炸了')
    }
    // React 会把错误同时打到 console.error：这里静音，避免污染测试输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    spy.mockRestore()

    expect(container.querySelector('details')).toBeNull()
    const toggle = screen.getByRole('button', { name: /技术细节/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('收起技术细节')
    expect(container.querySelector('pre')).toBeInTheDocument()
  })
})

describe('工作区面板与版本提示的无障碍', () => {
  it('折叠态启动器与服务端面板均无 axe 违规，图标按钮有可访问名', async () => {
    const user = userEvent.setup()
    const { container } = render(<WorkspaceDock />)
    expect(screen.getByRole('button', { name: '终端与预览' })).toBeInTheDocument()
    await expectNoA11yViolations(container)

    await user.click(screen.getByRole('button', { name: '终端与预览' }))
    await expectNoA11yViolations(container)
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('版本不一致提示条无 axe 违规', async () => {
    vi.mocked(versionMismatch).mockReturnValue({ ui: '0.1.0', server: '0.2.0' })
    const { container } = render(<VersionBanner />)
    expect(await screen.findByText(/界面版本/)).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('Markdown 表格与代码块无 axe 违规', async () => {
    const md = ['| 列 A | 列 B |', '| --- | --- |', '| a | `src/main.ts` |', '', '```ts', 'const a = 1', '```'].join('\n')
    const { container } = render(<Markdown text={md} onPreview={() => {}} />)
    expect(container.querySelector('table')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})
