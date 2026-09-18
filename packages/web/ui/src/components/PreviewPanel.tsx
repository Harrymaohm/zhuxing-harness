import { useEffect, useRef, useState } from 'react'

import { Icon } from './Icon'
import { apiFetch } from '../api'

/**
 * 从任意文本里识别本机可访问的地址（终端输出、助手答复、工具结果都适用）。
 *
 * 只认本机地址：预览面板会把识别结果塞进 iframe，允许任意外站等于给了个内嵌浏览器；
 * `0.0.0.0` 是「监听全部网卡」的写法，浏览器访问不到，统一改写成 127.0.0.1。
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'<>)\]，。；、]*)?/gi
const TRAILING = /[.,;:!?)\]}>"'，。；：！？）】]+$/

/** 回环写法的主机名：这些都指向本机，浏览器都访问得到。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

/**
 * 是否是「应用自己」的地址。
 *
 * 为什么必须排除：这个 Web UI 自身就跑在本机某个端口上，而对话与工具输出里经常出现这个地址
 * （AI 介绍服务地址、启动日志、自省结果等）。若把它当预览目标，iframe 里会装进一个完整的自己，
 * 而那个自己也会识别到同一个地址、再套一层——预览面板就这样无限套下去。
 * 判据是「同端口 + 回环」：那个端口被应用自己占着，别的服务不可能同时监听它。
 */
export function isSelfUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.port === location.port && LOOPBACK_HOSTS.has(u.hostname)) return true
    return u.origin === location.origin
  } catch {
    return false
  }
}

export function extractLocalUrls(text: string): string[] {
  const found: string[] = []
  for (const match of String(text ?? '').matchAll(LOCAL_URL)) {
    const cleaned = match[0].replace(TRAILING, '').replace('//0.0.0.0', '//127.0.0.1').replace('//[::1]', '//127.0.0.1')
    if (isSelfUrl(cleaned)) continue
    if (!found.includes(cleaned)) found.push(cleaned)
  }
  return found
}

type Mode = 'url' | 'file'

/**
 * 预览面板：一个地址栏，既能开本机网页，也能开工作区里的文件。
 *
 * 地址栏是唯一的入口（参考 Trae 的预览范式）：输入 `http://…` 走内嵌页面，
 * 输入路径（如 `src/App.tsx`）走文件内容。识别到的本机地址以 chip 形式列出，
 * 点一下即切过去，不必手打。
 *
 * 网页用普通 iframe（不加 sandbox）：被预览页面跑在**另一个端口**上，与宿主天然跨源，
 * 拿不到父页面 DOM；而加上 sandbox 会连脚本一起禁掉，绝大多数 dev server 会白屏。
 * 文件走 `/api/files/preview`（需要认证头，所以只能由前端取回再渲染，不能直接给 iframe 的 src）。
 */
export function PreviewPanel({ urls }: { urls: string[] }) {
  const [addr, setAddr] = useState('')
  const [mode, setMode] = useState<Mode>('url')
  const [activeUrl, setActiveUrl] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  const [file, setFile] = useState<{ path: string; content: string; size: number } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /**
   * 用户是否亲自指定过地址（点 chip、手输、点「在新窗口打开」都算）。
   *
   * 没有这个标记时，「自动跟随最新识别地址」会在每次 activeUrl 变化后把它覆盖回去：
   * 手输的地址只要不在识别列表里（绝大多数手输都不在），下一次 effect 就被改回旧地址——
   * 表现成「输了没反应」，连「这是应用自身地址」的提示都会被冲掉。
   */
  const manualRef = useRef(false)

  // 自动跟随最新识别到的地址，但仅限用户从未亲自指定过地址的情况
  useEffect(() => {
    if (manualRef.current) return
    if (urls.length === 0 || mode !== 'url') return
    if (!activeUrl || !urls.includes(activeUrl)) {
      const next = urls[urls.length - 1]
      setActiveUrl(next)
      setAddr(next)
    }
  }, [urls, activeUrl, mode])

  const go = async (raw: string) => {
    const value = raw.trim()
    if (!value) return
    manualRef.current = true
    setAddr(value)
    setError('')
    if (/^https?:\/\//i.test(value)) {
      // 手动输入自身地址同样要拦：自动识别拦住了，这里放开等于留了个套娃入口
      if (isSelfUrl(value)) {
        setMode('url')
        setActiveUrl('')
        setFile(null)
        setError('这是应用自身的地址：在预览里打开它会套进一个完整的自己，并且会继续无限套下去。看生成的文件请填工作区路径，预览页面请填本机 dev server 的地址。')
        return
      }
      setMode('url')
      setActiveUrl(value)
      setFile(null)
      setReloadSeq((n) => n + 1)
      return
    }
    setMode('file')
    setLoading(true)
    try {
      const res = await apiFetch(`/api/files/preview?path=${encodeURIComponent(value)}`)
      const data = (await res.json().catch(() => ({}))) as { path?: string; content?: string; size?: number; error?: string }
      if (!res.ok) {
        setFile(null)
        setError(data.error ?? `读取失败（HTTP ${res.status}）`)
      } else {
        setFile({ path: data.path ?? value, content: data.content ?? '', size: data.size ?? 0 })
      }
    } catch (err) {
      setFile(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const reload = () => {
    if (mode === 'url') setReloadSeq((n) => n + 1)
    else void go(addr)
  }

  const list = [...urls].reverse()

  return (
    <div className="xd-preview">
      <div className="xd-preview-bar">
        <input
          className="xd-addr-input"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void go(addr)
            }
          }}
          placeholder="输入本机地址（http://…）或工作区文件路径，回车预览"
          spellCheck={false}
        />
        <div className="xd-term-actions">
          <button className="xd-icon-btn" aria-label="刷新" title="刷新" onClick={reload} disabled={!addr.trim()}>
            <Icon name="refresh" size={13} />
          </button>
          <button
            className="xd-icon-btn"
            aria-label="在新窗口打开"
            title="在新窗口打开"
            disabled={mode !== 'url' || !activeUrl}
            onClick={() => window.open(activeUrl, '_blank', 'noopener,noreferrer')}
          >
            <Icon name="external" size={13} />
          </button>
        </div>
      </div>

      {list.length > 0 && (
        <div className="xd-url-list">
          {list.map((u) => (
            <button
              key={u}
              className={`xd-url-chip${mode === 'url' && u === activeUrl ? ' xd-url-chip-active' : ''}`}
              onClick={() => void go(u)}
              title={u}
            >
              {u.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </div>
      )}

      {mode === 'url' ? (
        activeUrl ? (
          <iframe
            key={`${activeUrl}#${reloadSeq}`}
            className="xd-frame"
            src={activeUrl}
            title="网页预览"
            referrerPolicy="no-referrer"
          />
        ) : error ? (
          <div className="xd-empty xd-err">{error}</div>
        ) : (
          <div className="xd-empty xd-empty-lg">
            <p>还没有可预览的内容。</p>
            <p className="xd-dim">
              在上面输入工作区里的文件路径（如 <code>README.md</code>）即可查看生成的文件；在终端启动本地服务（例如{' '}
              <code>pnpm dev</code>）后，本机地址会自动出现在这里。
            </p>
          </div>
        )
      ) : (
        <div className="xd-file">
          <div className="xd-file-meta">
            <span className="xd-cwd" title={file?.path ?? addr}>
              {file?.path ?? addr}
            </span>
            {file && <span className="xd-dim">{file.size.toLocaleString()} 字节</span>}
          </div>
          {loading ? (
            <div className="xd-empty">读取中…</div>
          ) : error ? (
            <div className="xd-empty xd-err">{error}</div>
          ) : file ? (
            <pre className="xd-file-body">{file.content}</pre>
          ) : (
            <div className="xd-empty">输入工作区内的文件路径，回车预览内容。</div>
          )}
        </div>
      )}
    </div>
  )
}
