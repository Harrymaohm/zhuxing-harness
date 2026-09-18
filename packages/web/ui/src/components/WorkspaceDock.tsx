import { useEffect, useMemo, useRef, useState } from 'react'

import { Icon } from './Icon'
import { TerminalPanel } from './TerminalPanel'
import { PreviewPanel, extractLocalUrls } from './PreviewPanel'
import { useTerminal } from '../hooks/useTerminal'
import type { ChatMessage } from '../types'
import './workspace-dock.css'

/**
 * 按间隔取样。
 *
 * 存在的理由：流式期间 messages 每个 token 都换新对象，而下面的地址识别要跑正则
 * （最多 3 × 20k 字符）。若跟着每个 token 重算，一个长回答就是一次 O(n²) 主线程占用——
 * 这正好会表现成「回答越长越卡、最后界面不再更新」。取样后最多每 500ms 重算一次。
 */
function useSampled<T>(value: T, ms = 500): T {
  const [snap, setSnap] = useState(value)
  const lastRef = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, ms - (Date.now() - lastRef.current))
    const timer = window.setTimeout(() => {
      lastRef.current = Date.now()
      setSnap(value)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return snap
}

/** 预览面板最多保留多少个识别到的本机地址（最新的在前）。 */
const MAX_PREVIEW_URLS = 8

/**
 * 工作区面板：终端 + 网页预览。
 *
 * 挂载方式刻意做成「右下角浮层 + 自身带开关」，因此主界面只需要一行接线，
 * 不需要改动既有布局——这也是它能与正在并行改动的界面代码共存的原因。
 *
 * 预览地址的来源有两处：终端输出（用户自己起 dev server）与最近对话
 * （AI 跑命令或直接给出地址）。只扫最近 3 条消息并限长：流式期间消息内容
 * 每个 token 都在变，全量扫描会把主线程拖死。
 */
export function WorkspaceDock({ messages }: { messages?: ChatMessage[] }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'terminal' | 'preview'>('terminal')
  const terminal = useTerminal()
  const sampledEntries = useSampled(terminal.entries)
  const sampledMessages = useSampled(messages)

  const urls = useMemo(() => {
    const texts: string[] = sampledEntries.map((e) => e.output)
    for (const m of (sampledMessages ?? []).slice(-3)) {
      if (m.content) texts.push(m.content.slice(0, 20_000))
      for (const item of m.trace ?? []) {
        if (item.toolResult) texts.push(item.toolResult.slice(0, 20_000))
      }
    }
    const found: string[] = []
    for (const text of texts) {
      for (const url of extractLocalUrls(text)) if (!found.includes(url)) found.push(url)
    }
    // 只留最近 8 条：跑几次 dev server、改几回端口就会攒出十几个地址，
    // chip 一行放不下、也没人会往回翻；面板里显示顺序是最新在前（那边会 reverse）。
    return found.slice(-MAX_PREVIEW_URLS)
  }, [sampledEntries, sampledMessages])

  if (!open) {
    return (
      <button className="xd-launcher" onClick={() => setOpen(true)} aria-label="终端与预览" title="终端与预览">
        <Icon name="terminal" size={14} />
        {urls.length > 0 && <span className="xd-dot" />}
      </button>
    )
  }

  return (
    <aside className="xd-dock" aria-label="工作区面板">
      <div className="xd-head">
        <div className="xd-tabs">
          <button
            className={`xd-tab${tab === 'terminal' ? ' xd-tab-active' : ''}`}
            onClick={() => setTab('terminal')}
          >
            <Icon name="terminal" size={13} /> 终端
            {terminal.running && <span className="xd-dot" />}
          </button>
          <button className={`xd-tab${tab === 'preview' ? ' xd-tab-active' : ''}`} onClick={() => setTab('preview')}>
            <Icon name="external" size={13} /> 预览
            {urls.length > 0 && <span className="xd-badge">{urls.length}</span>}
          </button>
        </div>
        <button className="xd-icon-btn" onClick={() => setOpen(false)} aria-label="收起" title="收起">
          <Icon name="close" size={13} />
        </button>
      </div>

      {tab === 'terminal' ? (
        <TerminalPanel
          entries={terminal.entries}
          running={terminal.running}
          onRun={(command) => void terminal.run(command)}
          onStop={terminal.stop}
          onClear={terminal.clear}
        />
      ) : (
        <PreviewPanel urls={urls} />
      )}
    </aside>
  )
}
