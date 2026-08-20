import { useCallback, useEffect, useRef, useState } from 'react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'step'
  content?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  error?: boolean
  step?: number
  sessionId?: string
  steps?: number
  finishedReason?: string
}

interface SessionItem {
  id: string
  eventCount: number
  createdAt?: number
  preview?: string
}

interface WebConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: string
}

let msgId = 0
const nextId = () => `m${++msgId}`

function summarize(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { text?: string; error?: string; json?: unknown }
  if (typeof r === 'object') {
    if (r.error !== undefined) return `错误: ${r.error}`
    if (r.text !== undefined) return r.text
    if (r.json !== undefined) return JSON.stringify(r.json).slice(0, 120)
  }
  return String(result).slice(0, 120)
}

export function App() {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<WebConfig>({})
  const [error, setError] = useState('')
  const sessionIdRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions')
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionItem[] }
        setSessions(data.sessions)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config')
      if (res.ok) setConfig((await res.json()) as WebConfig)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    void loadConfig()
  }, [refreshSessions, loadConfig])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function newChat() {
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
  }

  async function openSession(id: string) {
    setRunning(false)
    abortRef.current?.abort()
    const res = await fetch(`/api/sessions/${id}/events`)
    if (!res.ok) return
    const data = (await res.json()) as { events: Array<{ type: string; source: string; payload: unknown }> }
    const list: ChatMessage[] = []
    for (const evt of data.events) {
      const p = evt.payload as { content?: string; name?: string; args?: unknown; result?: unknown; toolCalls?: unknown }
      if (evt.type === 'user') list.push({ id: nextId(), role: 'user', content: p.content ?? '' })
      else if (evt.type === 'assistant') {
        list.push({ id: nextId(), role: 'assistant', content: p.content ?? '', sessionId: id })
      } else if (evt.type === 'tool') {
        list.push({
          id: nextId(),
          role: 'tool',
          toolName: String(p.name ?? ''),
          toolArgs: p.args ? JSON.stringify(p.args).slice(0, 200) : '',
          toolResult: p.result ? summarize(p.result) : '',
        })
      }
    }
    setMessages(list)
    sessionIdRef.current = id
    setError('')
  }

  async function saveConfigPatch(patch: Partial<WebConfig>) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      setConfig((prev) => ({ ...prev, ...patch }))
      setShowSettings(false)
    }
  }

  async function send() {
    const message = input.trim()
    if (!message || running) return
    setInput('')
    setError('')
    setRunning(true)

    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: message }
    const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '' }
    setMessages((prev) => [...prev, userMsg, assistantMsg])

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId: sessionIdRef.current }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`请求失败（HTTP ${res.status}）`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let event = ''

      const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantMsg.id)
          if (idx < 0) return prev
          const copy = [...prev]
          copy[idx] = fn(copy[idx])
          return copy
        })
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
            handleSseEvent(event, data, patchAssistant)
            event = ''
          }
        }
      }
      void refreshSessions()
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err))
        patchAssistant((m) => ({ ...m, content: m.content || '（发生错误）', error: true }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  function handleSseEvent(
    event: string,
    data: Record<string, unknown>,
    patchAssistant: (fn: (m: ChatMessage) => ChatMessage) => void,
  ) {
    switch (event) {
      case 'step':
        setMessages((prev) => [...prev, { id: nextId(), role: 'step', step: Number(data.step) }])
        break
      case 'tool':
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'tool',
            toolName: String(data.name ?? ''),
            toolArgs: data.args ? JSON.stringify(data.args).slice(0, 200) : '',
          },
        ])
        break
      case 'tool_result':
        setMessages((prev) => {
          const copy = [...prev]
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'tool' && copy[i].toolName === data.name) {
              copy[i] = { ...copy[i], toolResult: summarize(data.result) }
              break
            }
          }
          return copy
        })
        break
      case 'token':
        patchAssistant((m) => ({ ...m, content: `${m.content ?? ''}${String(data.text ?? '')}` }))
        break
      case 'result':
        sessionIdRef.current = String(data.sessionId ?? '')
        patchAssistant((m) => ({
          ...m,
          steps: Number(data.steps ?? 0),
          finishedReason: String(data.finishedReason ?? ''),
          sessionId: String(data.sessionId ?? ''),
        }))
        break
      case 'error':
        patchAssistant((m) => ({ ...m, content: `${m.content ?? ''}\n[错误] ${String(data.message ?? '')}`, error: true }))
        break
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">筑星 Harness</span>
        </div>
        <button className="btn new-chat" onClick={newChat}>
          + 新对话
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <button key={s.id} className="session-item" onClick={() => void openSession(s.id)} title={s.id}>
              <div className="session-title">{s.preview || s.id.slice(0, 12)}</div>
              <div className="session-meta">
                {s.eventCount} 事件 · {s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : ''}
              </div>
            </button>
          ))}
          {sessions.length === 0 && <div className="empty-hint">暂无会话</div>}
        </div>
        <button className="btn settings-btn" onClick={() => setShowSettings(true)}>
          ⚙ 设置
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <span>对话 · 工作 · 交付</span>
          {config.model && <span className="model-badge">{config.model}</span>}
        </header>

        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>你好，我是筑星 Harness</h2>
              <p>可随意接入插件的 Agent 运行时。直接下达任务，我会调用工具完成对话、工作与交付。</p>
              <div className="suggestions">
                {['总结当前目录结构', '调用 hello 工具打个招呼', '阅读 README.md 并总结'].map((s) => (
                  <button key={s} className="chip" onClick={() => setInput(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
          {error && <div className="error-banner">✗ {error}</div>}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="输入任务描述，Enter 发送 / Shift+Enter 换行"
            rows={2}
            disabled={running}
          />
          <button className="btn send-btn" onClick={() => void send()} disabled={running || !input.trim()}>
            {running ? '…' : '发送'}
          </button>
        </div>
      </main>

      {showSettings && <SettingsModal config={config} onSave={saveConfigPatch} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{msg.content}</div>
      </div>
    )
  }
  if (msg.role === 'step') {
    return <div className="msg step">▶ 第 {msg.step} 步：调用模型…</div>
  }
  if (msg.role === 'tool') {
    return (
      <div className="msg tool">
        <div className="tool-card">
          <div className="tool-name">🔧 {msg.toolName}</div>
          {msg.toolArgs && <div className="tool-args">{msg.toolArgs}</div>}
          {msg.toolResult !== undefined && (
            <div className={`tool-result ${msg.toolResult.startsWith('错误') ? 'err' : ''}`}>{msg.toolResult}</div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <div className={`bubble ${msg.error ? 'err' : ''}`}>
        <AssistantContent msg={msg} />
        {msg.finishedReason && (
          <div className="delivery">
            <span className="badge ok">交付完成</span>
            <span className="meta">
              步骤 {msg.steps} · {msg.finishedReason}
              {msg.sessionId ? ` · 会话 ${msg.sessionId.slice(0, 8)}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 助手内容：长结果默认折叠展示（最终输出折叠），点击展开完整内容。 */
function AssistantContent({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const content = msg.content ?? ''
  const long = content.length > 400
  const shown = long && !expanded ? `${content.slice(0, 300)}…` : content
  return (
    <>
      <div className="assistant-content">{shown || (msg.steps ? '' : '思考中…')}</div>
      {long && (
        <button className="fold-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起 ↑' : `展开 ↓（完整 ${content.length} 字符）`}
        </button>
      )}
    </>
  )
}

function SettingsModal({
  config,
  onSave,
  onClose,
}: {
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<WebConfig>(config)
  const fields: Array<{ key: keyof WebConfig; label: string; placeholder: string; type?: string }> = [
    { key: 'apiKey', label: 'API Key', placeholder: 'sk-…', type: 'password' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.deepseek.com/v1' },
    { key: 'model', label: '模型', placeholder: 'deepseek-v4-flash' },
    { key: 'workspace', label: '工作区', placeholder: '绝对路径' },
    { key: 'level', label: '沙箱级别', placeholder: 'read-only / workspace-write / danger-full-access' },
  ]
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        {fields.map((f) => (
          <label key={f.key} className="field">
            <span>{f.label}</span>
            <input
              type={f.type ?? 'text'}
              value={form[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </label>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onSave(form)}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
