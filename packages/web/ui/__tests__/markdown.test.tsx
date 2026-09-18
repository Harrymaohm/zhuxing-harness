// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  FOLD_BLOCK_LIMIT,
  Markdown,
  foldAtBoundary,
  parseBlocks,
  parsePathRef,
  splitGrowingTail,
  type MdBlock,
} from '../src/components/markdown'

/**
 * Markdown 渲染契约的行为测试（计划书 P0-4：门槛上调前先补真断言）。
 * 断言的是「用户看到什么」——块类型、流式占位、折叠边界、可点路径——不是快照。
 */

const noop = () => {}
function md(text: string, onPreview = noop, foldLimit?: number) {
  return render(<Markdown text={text} onPreview={onPreview} foldLimit={foldLimit} />)
}

describe('parseBlocks：块解析', () => {
  it('围栏代码块：带语言、闭合与未闭合（流式）分别定型', () => {
    const blocks = parseBlocks('```ts\nconst a = 1\n```\n\n```python\nx = 1')
    expect(blocks[0]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1', complete: true })
    const tail = blocks[1]
    expect(tail.kind).toBe('code')
    expect(tail).toMatchObject({ lang: 'python', complete: false })
  })

  it('标题按 # 数定级；分隔线与引用块各自成块', () => {
    const blocks = parseBlocks('### 小节\n\n---\n\n> 引一行\n> 引两行')
    expect(blocks[0]).toEqual({ kind: 'heading', level: 3, text: '小节' })
    expect(blocks[1]).toEqual({ kind: 'hr' })
    expect(blocks[2]).toEqual({ kind: 'quote', text: '引一行\n引两行' })
  })

  it('表格：表头+分隔行+数据行；列表项缩进续行并入上一项', () => {
    const blocks = parseBlocks('| 名 | 值 |\n| --- | --- |\n| a | 1 |\n\n- 第一项\n  续行内容\n- 第二项')
    const table = blocks[0] as Extract<MdBlock, { kind: 'table' }>
    expect(table.headers).toEqual(['名', '值'])
    expect(table.rows).toEqual([['a', '1']])
    const list = blocks[1] as Extract<MdBlock, { kind: 'list' }>
    expect(list.items[0]).toBe('第一项\n续行内容')
  })

  it('流式表头（分隔行未到）解析为 pending-table 占位，不降级成段落', () => {
    expect(parseBlocks('前面段落\n\n| 列一 | 列二 |')).toContainEqual({
      kind: 'pending-table',
      text: '| 列一 | 列二 |',
    })
  })

  it('有序列表独立识别', () => {
    const blocks = parseBlocks('1. 甲\n2. 乙')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, items: ['甲', '乙'] })
  })
})

describe('按块折叠与流式切分（纯函数）', () => {
  const done = { kind: 'hr' } as MdBlock
  const pending = { kind: 'code', text: '', complete: false } as MdBlock

  it('foldAtBoundary 只截在块边界，且绝不含末尾未完成块', () => {
    expect(foldAtBoundary([done, done, pending, done], 4)).toBe(2)
    expect(foldAtBoundary([done, done, done], 2)).toBe(2)
    expect(foldAtBoundary([], 3)).toBe(0)
  })

  it('splitGrowingTail：短文本不切；围栏奇偶失衡不切；正常长文本在末尾空行切', () => {
    expect(splitGrowingTail('短')).toEqual(['', '短'])
    const noGap = 'x'.repeat(5000)
    expect(splitGrowingTail(noGap)).toEqual(['', noGap])
    const oddFence = `${'a'.repeat(3000)}\n\n\`\`\`ts\n代码\n\n${'b'.repeat(2000)}`
    expect(splitGrowingTail(oddFence)).toEqual(['', oddFence])
    const ok = `${'a'.repeat(3000)}\n\n${'b'.repeat(2000)}`
    const [head, tail] = splitGrowingTail(ok)
    expect(head).toBe('a'.repeat(3000))
    expect(tail).toBe(`\n\n${'b'.repeat(2000)}`)
  })
})

describe('parsePathRef：哪些反引号片段可点开', () => {
  it('带扩展名或带行号才可点；URL、目录、裸标识符不可点', () => {
    expect(parsePathRef('src/main.ts')).toEqual({ path: 'src/main.ts' })
    expect(parsePathRef('runtime.ts:107')).toEqual({ path: 'runtime.ts', line: 107 })
    expect(parsePathRef('Makefile:12')).toEqual({ path: 'Makefile', line: 12 })
    expect(parsePathRef('server.ts:10:22')).toEqual({ path: 'server.ts', line: 10 })
    expect(parsePathRef('https://example.com/a.ts')).toBeNull()
    expect(parsePathRef('packages/web/')).toBeNull()
    expect(parsePathRef('useState')).toBeNull()
    expect(parsePathRef('a b.txt')).toBeNull()
    expect(parsePathRef('')).toBeNull()
  })
})

describe('行内渲染', () => {
  it('http 链接新窗口打开；相对链接只是带 title 的文本', () => {
    const { container } = md('[官网](https://trae.cn) 与 [内部](./docs/a.md)')
    const a = container.querySelector('a.md-link')!
    expect(a).toHaveAttribute('href', 'https://trae.cn')
    expect(a).toHaveAttribute('target', '_blank')
    const span = [...container.querySelectorAll('span')].find((s) => s.textContent === '内部')
    expect(span).toHaveAttribute('title', './docs/a.md')
  })

  it('可点路径渲染为按钮，点击回调携带 path 与 line；普通代码保持 <code>', () => {
    const onPreview = vi.fn()
    md('查 `App.tsx:42` 和 `useState`', onPreview)
    const btn = screen.getByRole('button', { name: 'App.tsx:42' })
    expect(btn).toHaveAttribute('title', 'App.tsx 第 42 行')
    fireEvent.click(btn)
    expect(onPreview).toHaveBeenCalledWith('App.tsx', 42)
    expect(document.querySelector('code')).toHaveTextContent('useState')
  })

  it('粗体斜体两套记号都认；段落内换行渲染为 <br>', () => {
    const { container } = md('**粗** __也粗__ *斜* _也斜_\n第二行')
    expect(container.querySelectorAll('strong')).toHaveLength(2)
    expect(container.querySelectorAll('em')).toHaveLength(2)
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })
})

describe('代码块交互', () => {
  it('无语言标注显示 text；复制成功变「已复制」，失败保持不变', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    md('```\nplain\n```')
    expect(screen.getByText('text')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: '复制' })
    fireEvent.click(btn)
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('plain')
    expect(screen.getByText('已复制')).toBeInTheDocument()
  })

  it('剪贴板拒绝时不显示已复制', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    md('```ts\nconst x = 1\n```')
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {})
    expect(screen.getByText('复制')).toBeInTheDocument()
    expect(screen.queryByText('已复制')).not.toBeInTheDocument()
  })

  it('未闭合围栏以 pending 样式呈现', () => {
    const { container } = md('```go\nnot done')
    expect(container.querySelector('pre.md-code-body.pending')).toBeInTheDocument()
  })
})

describe('表格与任务列表渲染', () => {
  it('列数取所有行最大值，缺格补空、多列不丢', () => {
    const { container } = md('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n| x |')
    const ths = container.querySelectorAll('thead th')
    expect(ths).toHaveLength(3)
    const lastRow = container.querySelectorAll('tbody tr')[1]
    expect(lastRow.querySelectorAll('td')).toHaveLength(3)
  })

  it('任务项按 [x]/[ ] 出勾选态，与普通项混排不串', () => {
    const { container } = md('- [x] 完成项\n- [ ] 未完成\n- 普通项')
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
    expect(container.querySelector('.md-task-text.done')).toHaveTextContent('完成项')
  })

  it('流式 pending-table 渲染为等宽占位而非段落', () => {
    const { container } = md('| 正在输入的表头 |')
    expect(container.querySelector('pre.md-pending')).toHaveTextContent('| 正在输入的表头 |')
  })
})

describe('Markdown 折叠交互', () => {
  /** 生成 n 个以空行分隔的完整块。 */
  const paras = (n: number) => Array.from({ length: n }, (_, i) => `段落${i}`).join('\n\n')

  it('块数不超过阈值不提供折叠', () => {
    md(paras(FOLD_BLOCK_LIMIT), noop)
    expect(screen.queryByRole('button', { name: /展开/ })).not.toBeInTheDocument()
  })

  it('超过阈值：折叠并明示剩余段数，点击展开、再点收起', () => {
    md(paras(10), noop, 3)
    const toggle = screen.getByRole('button', { name: /展开/ })
    expect(toggle).toHaveTextContent('还有 7 段')
    expect(screen.queryByText('段落9')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('段落9')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.queryByText('段落9')).not.toBeInTheDocument()
  })

  it('折叠边界不含未完成块：尾部生成中的代码块要么整块可见要么整块藏起', () => {
    md(`${paras(4)}\n\n\`\`\`ts\nconst growing = true`, noop, 3)
    // 前 3 个完整段可见，第 4 段（完整）也可见？foldAtBoundary 上限 3 → 只留 3 段
    expect(screen.getByText('段落2')).toBeInTheDocument()
    expect(screen.queryByText('段落3')).not.toBeInTheDocument()
    expect(screen.queryByText(/const growing/)).not.toBeInTheDocument()
  })

  it('长文本（切出已定型前缀）折叠时截断点落进前缀内部', () => {
    const head = Array.from({ length: 6 }, (_, i) => `长${'x'.repeat(600)}${i}`).join('\n\n')
    const tail = `\n\n${Array.from({ length: 6 }, (_, i) => `尾段${i}`).join('\n\n')}`
    md(head + tail, noop, 2)
    expect(screen.getByText(/^长x{600}0$/)).toBeInTheDocument()
    expect(screen.getByText(/^长x{600}1$/)).toBeInTheDocument()
    expect(screen.queryByText(/^长x{600}2$/)).not.toBeInTheDocument()
    expect(screen.queryByText('尾段0')).not.toBeInTheDocument()
  })
})
