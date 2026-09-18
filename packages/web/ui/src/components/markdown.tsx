import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Icon } from './Icon'

/** 路径预览回调：path 为工作区相对路径，line 为可选行号（1 起）。 */
export type PreviewHandler = (path: string, line?: number) => void

/**
 * 渲染契约（与提示词条款对应）：
 * - 块级：围栏代码块、表格、ATX 标题、无序/有序列表、引用块、分隔线、段落。
 * - 流式容忍：未闭合围栏渲染为「未完成」代码块，不影响其前的已完成块；
 *   表头已到而分隔行未到时渲染为等宽占位，不降级成段落（避免"竖线堆 → 真表格"跳变）。
 * - 折叠按块边界，不按字符：见 foldAtBoundary。
 */

/* ============================================================
   块解析
   ============================================================ */

export type MdBlock =
  | { kind: 'code'; lang?: string; text: string; complete: boolean }
  | { kind: 'table'; headers: string[]; rows: string[][]; complete: boolean }
  | { kind: 'pending-table'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[]; complete: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string }

const FENCE = /^\s*```(\w[\w+#.-]*)?\s*$/
const FENCE_CLOSE = /^\s*```\s*$/
const HEADING = /^\s*(#{1,6})\s+(.+?)\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?/
const UL_ITEM = /^\s*[-*+]\s+(.*)$/
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/

/** 该行是否开启一个新块（用于收束段落）。 */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    UL_ITEM.test(line) ||
    OL_ITEM.test(line)
  )
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function parseTable(lines: string[], at: number): { block: MdBlock; next: number } | null {
  if (!TABLE_ROW.test(lines[at]) || at + 1 >= lines.length || !TABLE_SEP.test(lines[at + 1])) return null
  const rows: string[][] = []
  let i = at + 2
  while (i < lines.length && TABLE_ROW.test(lines[i])) {
    rows.push(splitRow(lines[i]))
    i += 1
  }
  return { block: { kind: 'table', headers: splitRow(lines[at]), rows, complete: true }, next: i }
}

export function parseBlocks(text: string): MdBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1
      continue
    }

    const fence = FENCE.exec(lines[i])
    if (fence) {
      const code: string[] = []
      i += 1
      let closed = false
      while (i < lines.length) {
        if (FENCE_CLOSE.test(lines[i])) {
          closed = true
          i += 1
          break
        }
        code.push(lines[i])
        i += 1
      }
      blocks.push({ kind: 'code', lang: fence[1], text: code.join('\n'), complete: closed })
      continue
    }

    if (RULE.test(lines[i])) {
      blocks.push({ kind: 'hr' })
      i += 1
      continue
    }

    if (QUOTE.test(lines[i])) {
      const buf: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', text: buf.join('\n') })
      continue
    }

    const heading = HEADING.exec(lines[i])
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }

    const table = parseTable(lines, i)
    if (table) {
      blocks.push(table.block)
      i = table.next
      continue
    }

    // 表头已到、分隔行未到：流式期间渲染为等宽占位，避免先渲染成段落再跳成表格
    if (TABLE_ROW.test(lines[i]) && i + 1 >= lines.length) {
      blocks.push({ kind: 'pending-table', text: lines[i].trim() })
      i += 1
      continue
    }

    const ul = UL_ITEM.exec(lines[i])
    const ol = UL_ITEM.test(lines[i]) ? null : OL_ITEM.exec(lines[i])
    if (ul || ol) {
      const ordered = !ul
      const items: string[] = []
      while (i < lines.length) {
        const m = ordered ? OL_ITEM.exec(lines[i]) : UL_ITEM.exec(lines[i])
        if (m) {
          items.push(m[1])
          i += 1
          continue
        }
        // 列表项内的缩进续行并入上一项（不支持多级嵌套，见渲染契约）
        if (items.length > 0 && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] = `${items[items.length - 1]}\n${lines[i].trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, items, complete: i < lines.length })
      continue
    }

    const buf = [lines[i]]
    i += 1
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !TABLE_ROW.test(lines[i])) {
      buf.push(lines[i])
      i += 1
    }
    blocks.push({ kind: 'para', text: buf.join('\n') })
  }
  return blocks
}

/* ============================================================
   按块折叠
   ============================================================ */

/** 折叠阈值：块数超过该值才提供「收起」。 */
export const FOLD_BLOCK_LIMIT = 8

/**
 * 返回可安全显示的块数：只截断在块边界，且不含末尾未完成块。
 * 这样折叠态不会把围栏代码块或表格切一半。
 */
export function foldAtBoundary(blocks: MdBlock[], limit: number): number {
  let count = 0
  for (let i = 0; i < blocks.length && count < limit; i++) {
    const b = blocks[i]
    if ('complete' in b && !b.complete) break
    count = i + 1
  }
  return count
}

/**
 * 把「已定型前缀」与「仍在增长的尾部」切开，供 useMemo 缓存前缀、只重渲染尾部。
 * 切点取最后一个空行；若切点会使前缀内围栏奇偶失衡则放弃切分。
 * 短文本直接整体返回，避免无谓的语义切分。
 */
export function splitGrowingTail(text: string): [string, string] {
  if (text.length < 4000) return ['', text]
  const idx = text.lastIndexOf('\n\n')
  if (idx <= 0) return ['', text]
  const head = text.slice(0, idx)
  const fences = (head.match(/^\s*```/gm) ?? []).length
  if (fences % 2 !== 0) return ['', text]
  return [head, text.slice(idx)]
}

/* ============================================================
   行内渲染
   ============================================================ */

const INLINE_SPLIT = /(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/

/**
 * 从反引号内容识别可预览路径。
 * 可点开的条件（与服务端 `/api/files/preview` 的能力严格对齐）：
 *   含扩展名（`App.tsx`、`src/main.ts`），或带行号（`runtime.ts:107`、`Makefile:12`）。
 * 不可点：URL、目录（无目录列举接口）、纯标识符（`useState`）。
 */
export function parsePathRef(raw: string): { path: string; line?: number } | null {
  const t = raw.trim()
  if (!t || /\s/.test(t)) return null
  let path = t
  let line: number | undefined
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(t)
  if (m && m[1]) {
    path = m[1]
    line = Number(m[2])
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null
  // 目录与「无扩展名、无行号」的片段不做成可点：服务端只能预览文件
  if (/[\\/]$/.test(path)) return null
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(path)
  if (!hasExt && !line) return null
  return line ? { path, line } : { path }
}

export function renderInline(text: string, onPreview: PreviewHandler): ReactNode[] {
  return text.split(INLINE_SPLIT).map((part, index) => {
    const link = LINK.exec(part)
    if (link) {
      const [, label, href] = link
      if (/^https?:\/\//i.test(href)) {
        return (
          <a key={index} className="md-link" href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        )
      }
      return <span key={index} title={href}>{label}</span>
    }
    if (/^`[^`\n]+`$/.test(part)) {
      const ref = parsePathRef(part.slice(1, -1))
      if (ref) {
        return (
          <button
            key={index}
            className="file-link"
            onClick={() => onPreview(ref.path, ref.line)}
            title={ref.line ? `${ref.path} 第 ${ref.line} 行` : ref.path}
          >
            {part.slice(1, -1)}
          </button>
        )
      }
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    if (/^\*\*[^*\n]+\*\*$/.test(part) || /^__[^_\n]+__$/.test(part)) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    if (/^\*[^*\n]+\*$/.test(part) || /^_[^_\n]+_$/.test(part)) {
      return <em key={index}>{part.slice(1, -1)}</em>
    }
    const segs = part.split('\n')
    // 单行纯文本直接返回字符串，避免为每段文字多包一层 span
    if (segs.length === 1) return part
    return (
      <span key={index}>
        {segs.map((seg, si) => (
          <span key={si}>
            {seg}
            {si < segs.length - 1 && <br />}
          </span>
        ))}
      </span>
    )
  })
}

/* ============================================================
   块渲染
   ============================================================ */

function CodeBlock({ lang, text, complete }: { lang?: string; text: string; complete: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      },
      () => setCopied(false),
    )
  }
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button className="md-code-copy" onClick={copy} title="复制代码">
          <Icon name={copied ? 'check' : 'file'} size={13} />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={`md-code-body${complete ? '' : ' pending'}`}>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function MdTable({ headers, rows, onPreview }: { headers: string[]; rows: string[][]; onPreview: PreviewHandler }) {
  // 列数取表头与所有行的最大值：多余列不静默丢弃
  const cols = rows.reduce((n, row) => Math.max(n, row.length), headers.length)
  return (
    <div className="markdown-table-wrap">
      <table className="markdown-table">
        <thead>
          <tr>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i}>{renderInline(headers[i] ?? '', onPreview)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {Array.from({ length: cols }, (_, j) => (
                <td key={j}>{renderInline(row[j] ?? '', onPreview)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TaskItem({ text, onPreview }: { text: string; onPreview: PreviewHandler }) {
  const m = /^\[([ xX])\]\s*(.*)$/.exec(text)
  if (!m) return null
  const checked = m[1].toLowerCase() === 'x'
  return (
    <li className="md-task">
      <input type="checkbox" checked={checked} readOnly aria-label={checked ? '已完成' : '未完成'} />
      <span className={checked ? 'md-task-text done' : 'md-task-text'}>{renderInline(m[2], onPreview)}</span>
    </li>
  )
}

function renderBlock(block: MdBlock, key: number, onPreview: PreviewHandler): JSX.Element {
  switch (block.kind) {
    case 'code':
      return <CodeBlock key={key} lang={block.lang} text={block.text} complete={block.complete} />
    case 'table':
      return <MdTable key={key} headers={block.headers} rows={block.rows} onPreview={onPreview} />
    case 'pending-table':
      return (
        <pre key={key} className="md-pending" aria-label="表格生成中">
          {block.text}
        </pre>
      )
    case 'heading': {
      const Heading = `h${Math.min(6, block.level)}` as keyof JSX.IntrinsicElements
      return <Heading key={key}>{renderInline(block.text, onPreview)}</Heading>
    }
    case 'quote':
      return <blockquote key={key} className="md-quote">{renderInline(block.text, onPreview)}</blockquote>
    case 'hr':
      return <hr key={key} className="md-hr" />
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List key={key}>
          {block.items.map((item, i) => {
            // 任务项与普通项可混排：只在该项自身匹配时才渲染复选框
            const isTask = /^\[[ xX]\]\s*/.test(item)
            return isTask ? (
              <TaskItem key={i} text={item} onPreview={onPreview} />
            ) : (
              <li key={i}>{renderInline(item, onPreview)}</li>
            )
          })}
        </List>
      )
    }
    case 'para':
      return <p key={key}>{renderInline(block.text, onPreview)}</p>
  }
}

export function renderBlocks(blocks: MdBlock[], onPreview: PreviewHandler): JSX.Element[] {
  return blocks.map((b, i) => renderBlock(b, i, onPreview))
}

/**
 * Markdown 视图。
 *
 * 流式性能：把文本切成「已定型前缀 / 增长尾部」分别缓存，流式期间每来一个 token
 * 只重解析最后一段，而不是把整篇回复重新解析一遍（否则是 O(n²)）。
 * 对外回调先进 ref 再包成稳定引用，避免上层新建箭头函数把 memo 全部击穿。
 *
 * 折叠：传 foldLimit 即启用（块数阈值），截断点严格落在块边界，且不含未完成块。
 * 流式期间上层应传 null，使内容始终完整可见。
 */
export function Markdown({
  text,
  onPreview,
  foldLimit,
}: {
  text: string
  onPreview: PreviewHandler
  foldLimit?: number | null
}) {
  const [expanded, setExpanded] = useState(false)

  const handlerRef = useRef(onPreview)
  handlerRef.current = onPreview
  const handler = useCallback<PreviewHandler>((path, line) => handlerRef.current(path, line), [])

  const [head, tail] = useMemo(() => splitGrowingTail(text), [text])
  const headBlocks = useMemo(() => parseBlocks(head), [head])
  const tailBlocks = useMemo(() => parseBlocks(tail), [tail])
  const headNodes = useMemo(() => renderBlocks(headBlocks, handler), [headBlocks, handler])
  const tailNodes = useMemo(() => renderBlocks(tailBlocks, handler), [tailBlocks, handler])

  const total = headNodes.length + tailNodes.length
  const canFold = foldLimit != null && total > foldLimit
  // 流式期间 canFold 为 false，短路后不会为折叠拼合块数组
  const cut = canFold && !expanded ? foldAtBoundary(headBlocks.concat(tailBlocks), foldLimit) : total
  const folding = canFold && !expanded && cut > 0
  const shown = folding ? cut : total
  const hidden = total - shown

  return (
    <>
      {shown >= headNodes.length ? headNodes : headNodes.slice(0, shown)}
      {shown > headNodes.length && tailNodes.slice(0, shown - headNodes.length)}
      {canFold && (
        // 与消息区折叠块同一套语义：可聚焦按钮 + aria-expanded + ▸/▾ 指示（视觉保持自身样式）
        <button className="fold-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          <span className="trae-caret">{expanded ? '▾' : '▸'}</span>
          {expanded ? '收起' : `展开（还有 ${hidden} 段）`}
        </button>
      )}
    </>
  )
}
