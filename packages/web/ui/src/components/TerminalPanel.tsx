import { useEffect, useRef, useState } from 'react'

import { Icon } from './Icon'
import type { TerminalEntry } from '../hooks/useTerminal'

/** 一条记录的状态摘要：把「为什么停了」讲清楚，而不是只给一个退出码。 */
function statusOf(e: TerminalEntry): { text: string; tone: 'run' | 'ok' | 'bad' } {
  if (e.error) return { text: e.error, tone: 'bad' }
  if (e.running) return { text: '运行中…', tone: 'run' }
  if (e.aborted) return { text: '已停止', tone: 'bad' }
  if (e.timedOut) return { text: '超时终止', tone: 'bad' }
  const parts: string[] = [`exit ${e.code ?? '—'}`]
  if (e.signal) parts.push(e.signal)
  if (typeof e.wallMs === 'number') parts.push(`${(e.wallMs / 1000).toFixed(2)}s`)
  if (e.truncated) parts.push('输出已截断')
  return { text: parts.join(' · '), tone: e.code === 0 ? 'ok' : 'bad' }
}

function EntryView({ entry }: { entry: TerminalEntry }) {
  const [copied, setCopied] = useState(false)
  const status = statusOf(entry)

  const copy = () => {
    void navigator.clipboard.writeText(entry.output).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      },
      () => setCopied(false),
    )
  }

  return (
    <div className="xd-entry">
      <div className="xd-entry-cmd">
        <span className="xd-prompt">$</span>
        <span className="xd-cmd-text">{entry.command}</span>
        {entry.output && (
          <button className="xd-icon-btn" onClick={copy} aria-label="复制输出" title="复制输出">
            <Icon name={copied ? 'check' : 'file'} size={13} />
          </button>
        )}
      </div>
      {entry.output && <pre className="xd-entry-out">{entry.output}</pre>}
      <div className={`xd-status xd-status-${status.tone}`}>{status.text}</div>
    </div>
  )
}

/**
 * 交互式终端面板。
 *
 * 定位：给用户一个「和 AI 同一个工作区、同一套沙箱策略」的命令入口，
 * 用来启动 dev server、跑测试、看构建输出——也就是预览面板的上游。
 */
export function TerminalPanel({
  entries,
  running,
  onRun,
  onStop,
  onClear,
  disabled,
}: {
  entries: TerminalEntry[]
  running: boolean
  onRun: (command: string) => void
  onStop: () => void
  onClear: () => void
  disabled?: boolean
}) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState(-1)
  const [stick, setStick] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const cwd = [...entries].reverse().find((e) => e.cwd)?.cwd

  // 只在用户本来就贴着底部时才自动跟随，避免把他翻上去看的内容拽回来
  useEffect(() => {
    if (!stick) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, stick])

  const submit = () => {
    const command = value.trim()
    if (!command || running || disabled) return
    onRun(command)
    setHistory((prev) => [...prev, command])
    setHistoryAt(-1)
    setValue('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1)
      setHistoryAt(next)
      setValue(history[next] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyAt < 0) return
      const next = historyAt + 1
      if (next >= history.length) {
        setHistoryAt(-1)
        setValue('')
        return
      }
      setHistoryAt(next)
      setValue(history[next] ?? '')
    }
  }

  return (
    <div className="xd-term">
      <div className="xd-term-bar">
        <span className="xd-cwd" title={cwd ?? '工作区目录'}>
          {cwd ?? '工作区目录'}
        </span>
        <div className="xd-term-actions">
          {entries.length > 0 && (
            <button className="xd-text-btn" onClick={onClear} disabled={running}>
              清空
            </button>
          )}
          {running ? (
            <button className="xd-text-btn xd-danger" onClick={onStop}>
              <Icon name="stop" size={12} /> 停止
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="xd-term-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {entries.length === 0 ? (
          <div className="xd-empty">
            在下方输入命令，它会在 AI 的同一个工作区里执行，并受同一套沙箱档位约束。
          </div>
        ) : (
          entries.map((e) => <EntryView key={e.id} entry={e} />)
        )}
      </div>

      <div className="xd-term-input">
        <span className="xd-prompt">$</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? '命令执行中…（点「停止」可中断）' : '输入命令，Enter 执行（↑ 调历史）'}
          disabled={disabled || running}
          spellCheck={false}
        />
        <button
          className="xd-run-btn"
          onClick={submit}
          disabled={!value.trim() || running || disabled}
          aria-label="执行命令"
          title="执行命令（Enter）"
        >
          <Icon name="play" size={13} />
        </button>
      </div>
    </div>
  )
}
