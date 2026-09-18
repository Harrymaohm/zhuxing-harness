import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, archiveSession, askKnowledge, clearKnowledge, createKnowledgeFolder, createKnowledgeSpace, createSpace, deleteKnowledgeDoc, deleteKnowledgeFolder, deleteKnowledgeSpace, deleteSession, fetchConfig, fetchKnowledgeDoc, fetchKnowledgeDocs, fetchKnowledgeFolders, fetchKnowledgeSpaces, fetchSessions, fetchSpaces, fileToBase64, forkSession, initAccessToken, mergeSession, moveKnowledgeDoc, reindexKnowledge, removeSpace, renameSession, stopChatRun, listActiveRuns, unarchiveSession, uploadDropFile, uploadKnowledge } from './api'
import type { ChatMessage, SessionItem, SpaceItem, WebConfig } from './types'
import type { KnowledgeDoc, KnowledgeDocDetail, KnowledgeFolder, KnowledgeHit, KnowledgeSpace } from './api'
import { Icon } from './components/Icon'
import { Markdown, FOLD_BLOCK_LIMIT } from './components/markdown'
import type { PreviewHandler } from './components/markdown'
import { WorkspaceDock } from './components/WorkspaceDock'
import { InlineError, InlineLoading } from './components/Inline'
import { rebuildMessages, summarize } from './lib/messages'
import { StreamBuffer } from './lib/stream-buffer'
import { useViewTransition } from './hooks/useViewTransition'
import { useModalA11y } from './hooks/useModalA11y'
import { useDebouncedValue } from './hooks/useDebouncedValue'

/**
 * 按需加载的重组件（见 `ui/src/views/`）。
 *
 * 它们各自带着重量级依赖（文件预览：mammoth + SheetJS + pptx-wasm；知识图谱：three + OrbitControls）
 * 或成片的面板代码（设置弹窗），而首屏真正用到的只有对话区。静态 import 会让所有人先下载一遍
 * 「可能永远用不到」的库，拆成独立 chunk 后它们只在用户点开预览 / 进设置 / 进知识库时才拉取。
 *
 * 放在 `views/` 而不是 `components/`：`components/` 是可在 jsdom 里单测的通用原语，且挂着
 * 覆盖率门槛（见 vitest.config.ts）；这些视图组件含 WebGL / wasm，本就无法在 jsdom 中跑单测。
 */
const FilePreview = lazy(() => import('./views/FilePreview').then((m) => ({ default: m.FilePreview })))
const SettingsModal = lazy(() => import('./views/SettingsModal').then((m) => ({ default: m.SettingsModal })))
const KnowledgeGraph = lazy(() => import('./views/KnowledgeGraph').then((m) => ({ default: m.KnowledgeGraph })))

let msgId = 0
const nextId = () => `m${++msgId}`

/** 上次打开的会话 id：刷新后据此恢复现场（内存里的状态刷新即丢）。 */
const LAST_SESSION_KEY = 'harness-last-session'

/** 读取上次会话；隐私模式下 localStorage 不可用，静默降级为「没有」。 */
function readLastSession(): string | undefined {
  try {
    return localStorage.getItem(LAST_SESSION_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function rememberLastSession(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id)
    else localStorage.removeItem(LAST_SESSION_KEY)
  } catch {
    /* 写不进去不影响功能，只是刷新后回到新对话 */
  }
}

/**
 * 是否是「提交」的回车。
 *
 * 中文/日文输入法在选词时也会派发 Enter（此时 nativeEvent.isComposing 为真，keyCode 常为 229），
 * 不判断就会把半截拼音当消息发出去——这是中文用户的高频误操作。
 */
function isSubmitEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229
}

/** 从 file:// 或 file:/// URI 解析本地绝对路径（浏览器拖拽文件用）。 */
function fileUriToPath(uri: string): string | null {
  const raw = uri.trim()
  if (!raw) return null
  // 裸 Windows 路径：E:\foo.txt / E:/foo.txt（部分浏览器 uri-list 第二行为裸路径）
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw
  try {
    const u = new URL(raw)
    if (u.protocol !== 'file:') return null
    let p = decodeURIComponent(u.pathname)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // /E:/foo -> E:/foo
    return p
  } catch {
    return null
  }
}

/** ArrayBuffer → base64（分块避免调用栈溢出）。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/** 递归枚举拖入的文件夹（File System Access API），只收集 ≤50MB 的文件内容。 */
async function walkDirectory(dir: FileSystemDirectoryHandle, prefix: string, out: Array<{ name: string; data: ArrayBuffer }>): Promise<void> {
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile()
      if (file.size <= 50 * 1024 * 1024) {
        out.push({ name: prefix ? `${prefix}/${name}` : name, data: await file.arrayBuffer() })
      }
    } else if (handle.kind === 'directory') {
      await walkDirectory(handle as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name, out)
    }
  }
}

type Theme = 'dark' | 'light'

const THEME_KEY = 'harness-theme'

/**
 * 主题：暗色为默认，浅色为次主题。
 * 首帧由 index.html 的预置脚本写入 data-theme（避免闪白），此后以本 hook 为唯一真源。
 */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  )
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        /* 隐私模式下写入失败不阻塞切换 */
      }
      return next
    })
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return [theme, toggle]
}

export function App() {
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [spaces, setSpaces] = useState<SpaceItem[]>([])
  const [activeSpaceId, setActiveSpaceId] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  /** 选择作为参考上下文的另一个对话 id（空 = 不引用）。 */
  const [refSessionId, setRefSessionId] = useState('')
  const [running, setRunning] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [page, setPage] = useState<'chat' | 'knowledge'>('chat')
  const [config, setConfig] = useState<WebConfig>({})
  const [error, setError] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [toast, setToast] = useState('')
  /** 文件预览目标：路径 + 可选行号（反引号内 `path:line` 语法）。 */
  const [previewTarget, setPreviewTarget] = useState<{ path: string; line?: number } | null>(null)
  const [subChat, setSubChat] = useState<{ sessionId: string; parentId: string } | null>(null)
  /** 拖入的文件链接（绝对路径）。 */
  const [fileLinks, setFileLinks] = useState<Array<{ path: string; name: string }>>([])
  /** 拖入的图片附件（data URL，随消息发送给多模态模型）。 */
  const [attachments, setAttachments] = useState<Array<{ type: 'image'; dataUrl: string }>>([])
  const [dragging, setDragging] = useState(false)
  const [theme, toggleTheme] = useTheme()
  const morph = useViewTransition()
  const [railCollapsed, setRailCollapsed] = useState(false)
  const sessionIdRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  /** 本轮对话的服务端 runId：点「停止」时带着它请求服务端取消（只断 SSE 服务端不会停）。 */
  const runIdRef = useRef('')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const list = await fetchSessions(showArchived ? undefined : activeSpaceId, showArchived)
      setSessions(list)
    } catch {
      /* ignore */
    }
  }, [activeSpaceId, showArchived])

  const refreshSpaces = useCallback(async () => {
    try {
      const { spaces: list } = await fetchSpaces()
      setSpaces(list)
    } catch {
      /* ignore */
    }
  }, [])

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fetchConfig())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void (async () => {
      // 先取认证 token，再发起业务请求，避免竞态导致 401
      await initAccessToken()
      await refreshSessions()
      await refreshSpaces()
      await loadConfig()
    })()
  }, [refreshSessions, refreshSpaces, loadConfig])

  // 切换空间 / 归档视图时刷新会话列表
  useEffect(() => {
    void refreshSessions()
  }, [activeSpaceId, showArchived, refreshSessions])

  useEffect(() => {
    if (!autoScroll) return
    // 流式期间用即时滚动：smooth 动画会被下一个增量打断并重启，既浪费合成器线程，
    // 观感上也是「滚动抖动 / 跟不上」。非流式（切换会话、新消息落定）仍用平滑滚动。
    bottomRef.current?.scrollIntoView({ behavior: running ? 'auto' : 'smooth' })
  }, [messages, autoScroll, running])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  function showToast(message: string) {
    setToast(message)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(''), 2600)
  }

  /**
   * 处理一组 File：图片 → 附件；其他 → 上传到临时 drops 目录生成链接。
   * 命名优先 webkitRelativePath（选择文件夹时保留子目录结构）。
   */
  async function ingestFiles(files: File[]): Promise<{ uploaded: number; images: number; errors: string[] }> {
    const images: string[] = []
    const toUpload: Array<{ name: string; data: ArrayBuffer }> = []
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(r.result as string)
          r.onerror = () => reject(r.error ?? new Error(`读取图片失败：${f.name}`))
          r.readAsDataURL(f)
        })
        images.push(dataUrl)
      } else if (f.size <= 50 * 1024 * 1024) {
        toUpload.push({ name: f.webkitRelativePath || f.name, data: await f.arrayBuffer() })
      }
    }
    if (images.length > 0) setAttachments((prev) => [...prev, ...images.map((dataUrl) => ({ type: 'image' as const, dataUrl }))])
    const errors: string[] = []
    let uploaded = 0
    for (const uf of toUpload) {
      try {
        const p = await uploadDropFile(uf.name, arrayBufferToBase64(uf.data))
        if (p) {
          uploaded += 1
          setFileLinks((prev) =>
            prev.some((x) => x.path === p) ? prev : [...prev, { path: p, name: uf.name.split('/').pop() ?? uf.name }],
          )
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
    return { uploaded, images: images.length, errors }
  }

  function handleSelectFiles(list: FileList | null, isFolder: boolean) {
    const files = list ? Array.from(list) : []
    if (files.length === 0) return
    void (async () => {
      const result = await ingestFiles(files)
      const from = isFolder ? '文件夹' : '文件'
      if (result.uploaded > 0 && result.images > 0) showToast(`已从${from}导入 ${result.uploaded} 个文件 · ${result.images} 张图片`)
      else if (result.uploaded > 0) showToast(`已从${from}导入 ${result.uploaded} 个文件（可预览）`)
      else if (result.images > 0) showToast(`已添加 ${result.images} 张图片`)
      else if (result.errors.length > 0) showToast(`导入失败：${result.errors[0]}`)
      else showToast('没有可导入的文件（单文件上限 50 MB）')
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    })()
  }

  function handleMessagesScroll() {
    const el = messagesRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  function jumpToLatest() {
    setAutoScroll(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  function newChat() {
    detachRunning()
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
    rememberLastSession(undefined)
  }

  async function openSession(id: string) {
    setPage('chat')
    detachRunning()
    rememberLastSession(id)
    // 乐观标记目标会话：并发点击时，先回来的旧响应会发现自己已经不是当前目标，
    // 直接丢弃——否则会出现「标题是 B、正文是 A」这种错位。
    sessionIdRef.current = id
    const res = await apiFetch(`/api/sessions/${id}/events`)
    if (sessionIdRef.current !== id) return
    if (!res.ok) {
      setError(`会话加载失败（HTTP ${res.status}）`)
      return
    }
    const data = (await res.json()) as { events: Array<{ type: string; source: string; payload: unknown }> }
    if (sessionIdRef.current !== id) return
    setMessages(rebuildMessages(data.events, id, nextId))
    setError('')
    void attachActiveRun(id)
  }

  /**
   * 把仍在服务端运行的轮次重新挂上「停止」。
   *
   * 刷新窗口或重开客户端之后，内存里的 runId 就没了——不知道哪一轮还在跑，
   * 停止按钮于是失效，用户只能干看着它烧 token。这里向服务端问一次补回来。
   */
  async function attachActiveRun(sid: string | undefined): Promise<void> {
    if (!sid || abortRef.current) return
    const runs = await listActiveRuns()
    const hit = runs.find((r) => r.sessionId === sid)
    if (!hit) return
    runIdRef.current = hit.runId
    setRunning(true)
  }

  // 刷新/重开客户端后恢复现场：内存里的会话 id 与 runId 都没了。
  // 先取回上次打开的会话（不取回的话，下面的补挂永远是死代码——启动时 sid 必为 undefined），
  // 再由 openSession 内部把仍在服务端跑的轮次挂回「停止」。
  useEffect(() => {
    const last = readLastSession()
    if (last) void openSession(last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 离开或停止当前轮次时的统一收尾：先让服务端真停，再断开本地流，最后复位界面状态。
   *
   * 只断前端是不够的——服务端会把整轮跑完（白烧 token），而且会继续往已被丢弃的消息里
   * patch 内容；只复位界面不动流，则会出现「界面已经回到新对话、后台还在烧」。
   */
  function detachRunning(): void {
    const id = runIdRef.current
    runIdRef.current = ''
    if (id) void stopChatRun(id)
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }

  /** 「停止」：与离开会话同义，只是人还留在这个会话里。 */
  function handleStop(): void {
    detachRunning()
  }

  async function renameCurrentSession(id: string) {
    const title = editingTitle.trim()
    if (!title) {
      setEditingSessionId(null)
      return
    }
    const ok = await renameSession(id, title)
    if (!ok) {
      // 一次性动作的失败只走 toast：错误横幅在消息区，离侧栏的重命名操作点太远
      showToast('会话重命名失败')
      return
    }
    setEditingSessionId(null)
    setEditingTitle('')
    await refreshSessions()
  }

  function beginRename(session: SessionItem) {
    setEditingSessionId(session.id)
    setEditingTitle(session.title || session.preview || '')
  }

  async function handleFork(parentId: string) {
    try {
      const childId = await forkSession(parentId)
      setSubChat({ sessionId: childId, parentId })
      showToast('已创建子对话，可独立探索后合并回主对话')
      await refreshSessions()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '分叉失败')
    }
  }

  async function handleMerged(parentId: string) {
    setSubChat(null)
    await refreshSessions()
    if (sessionIdRef.current === parentId) await openSession(parentId)
  }

  async function handleArchive(id: string) {
    const ok = await archiveSession(id)
    if (ok) {
      showToast('已归档对话')
      await refreshSessions()
      await refreshSpaces()
    } else showToast('归档失败')
  }

  async function handleRestore(id: string) {
    const ok = await unarchiveSession(id)
    if (ok) {
      showToast('已恢复对话')
      await refreshSessions()
      await refreshSpaces()
    } else showToast('恢复失败')
  }

  async function handleDelete(id: string) {
    if (!window.confirm('确认删除该对话？此操作不可恢复。')) return
    const ok = await deleteSession(id)
    if (ok) {
      showToast('已删除对话')
      if (sessionIdRef.current === id) {
        detachRunning()
        setMessages([])
        sessionIdRef.current = undefined
        rememberLastSession(undefined)
      }
      await refreshSessions()
      await refreshSpaces()
    } else showToast('删除失败')
  }

  function handleSelectSpace(spaceId: string) {
    detachRunning()
    setActiveSpaceId(spaceId)
    setShowArchived(false)
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
    rememberLastSession(undefined)
  }

  async function handleNewSpace() {
    const title = window.prompt('输入空间名称（项目）', '')
    if (title === null) return
    const name = title.trim()
    if (!name) {
      showToast('空间名称不能为空')
      return
    }
    try {
      const space = await createSpace(name)
      await refreshSpaces()
      handleSelectSpace(space.id)
      showToast('已创建空间')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败')
    }
  }

  async function handleDeleteSpace(id: string) {
    const space = spaces.find((s) => s.id === id)
    const title = space?.title ?? '该空间'
    if (!window.confirm(`确认删除空间「${title}」及其全部会话？此操作不可恢复。`)) return
    const ok = await removeSpace(id)
    if (ok) {
      showToast('已删除空间')
      if (activeSpaceId === id) {
        setActiveSpaceId('')
        setMessages([])
        setError('')
        sessionIdRef.current = undefined
      }
      await refreshSpaces()
      await refreshSessions()
    } else {
      showToast('删除失败')
    }
  }

  function toggleArchived() {
    detachRunning()
    setShowArchived((v) => !v)
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
    rememberLastSession(undefined)
  }

  /**
   * 保存配置片段。
   *
   * 必须 await 且把失败讲出来：调用方此前用 setTimeout 假装「保存中…」，
   * 保存失败时弹窗不关也没有任何提示，用户只会觉得「点了没反应」。
   */
  async function saveConfigPatch(patch: Partial<WebConfig>): Promise<boolean> {
    try {
      const res = await apiFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        showToast(`保存失败（HTTP ${res.status}）`)
        return false
      }
      setConfig((prev) => ({ ...prev, ...patch }))
      setShowSettings(false)
      return true
    } catch (err) {
      showToast(err instanceof Error ? `保存失败：${err.message}` : '保存失败')
      return false
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)

    // 1) 文件链接（原路径）：从 uri-list 解析
    const uriList = e.dataTransfer.getData('text/uri-list')
    const uriPaths: string[] = []
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const p = fileUriToPath(line)
        if (p) uriPaths.push(p)
      }
    }
    if (uriPaths.length > 0) {
      setFileLinks((prev) => {
        const seen = new Set(prev.map((f) => f.path))
        return [...prev, ...uriPaths.filter((p) => !seen.has(p)).map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }))]
      })
    }

    // 2) 拖入的 File（文件拖拽 / 文件夹内文件）：图片附件 + 其余上传
    const dropFiles = Array.from(e.dataTransfer.files ?? [])
    // 3) 文件夹：同步收集 handle（避免 items 在异步后被清空）
    const items = Array.from(e.dataTransfer.items ?? [])
    const handlePromises: Array<Promise<FileSystemHandle | null>> = []
    let fsApiSupported = false
    for (const item of items) {
      const gfh = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle
      if (item.kind === 'file' && typeof gfh === 'function') {
        fsApiSupported = true
        handlePromises.push(Promise.resolve(gfh.call(item)))
      }
    }
    const ingest: File[] = [...dropFiles]
    if (handlePromises.length > 0) {
      for (const hp of handlePromises) {
        try {
          const handle = await hp
          if (!handle) continue
          if (handle.kind === 'directory') {
            const collected: Array<{ name: string; data: ArrayBuffer }> = []
            await walkDirectory(handle as FileSystemDirectoryHandle, '', collected)
            for (const c of collected) {
              ingest.push(new File([c.data], c.name.split('/').pop() ?? c.name, { lastModified: Date.now() }))
            }
          }
        } catch {
          /* 单个 handle 失败跳过 */
        }
      }
    }

    // 4) 统一 ingest（图片附件 + 上传 drops），不吞错误
    const result = await ingestFiles(ingest)

    // 5) 反馈
    if (uriPaths.length > 0 && (result.images > 0 || result.uploaded > 0)) {
      showToast(`已添加 ${uriPaths.length} 个文件链接 · 导入 ${result.uploaded + result.images} 个`)
    } else if (uriPaths.length > 0) {
      showToast(`已添加 ${uriPaths.length} 个文件链接`)
    } else if (result.uploaded > 0 || result.images > 0) {
      const parts: string[] = []
      if (result.uploaded > 0) parts.push(`${result.uploaded} 个文件`)
      if (result.images > 0) parts.push(`${result.images} 张图片`)
      showToast(`已导入 ${parts.join(' · ')}（可预览）`)
    } else if (result.errors.length > 0) {
      showToast(`导入失败：${result.errors[0]}`)
    } else if (dropFiles.length > 0 || items.length > 0) {
      if (fsApiSupported && items.some((i) => i.kind === 'file')) showToast('未读取到文件（单文件上限 50 MB）')
      else showToast('浏览器未提供本地路径；可用下方「选择文件/文件夹」按钮')
    }
  }

  async function send() {
    let message = input.trim()
    if (!message && fileLinks.length === 0 && attachments.length === 0) return
    if (running) return
    // 文件链接追加为消息文本（agent 用 read_file 工具读取）
    if (fileLinks.length > 0) {
      const links = fileLinks.map((f) => f.path).join('\n- ')
      message = message ? `${message}\n\n[附件文件]\n- ${links}` : `[附件文件]\n- ${links}`
    }
    const sentAttachments = attachments.length > 0 ? [...attachments] : undefined
    const sentLinks = fileLinks.length > 0 ? [...fileLinks] : []
    setInput('')
    setFileLinks([])
    setAttachments([])
    setError('')
    setRunning(true)

    const displayContent = sentLinks.length > 0 ? `${message}（${sentLinks.length} 个文件链接）` : message
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: displayContent,
      images: sentAttachments?.map((a) => a.dataUrl),
    }
    const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', running: true }
    setMessages((prev) => [...prev, userMsg, assistantMsg])

    const controller = new AbortController()
    abortRef.current = controller
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    runIdRef.current = runId

    const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsg.id)
        if (idx < 0) return prev
        const copy = [...prev]
        copy[idx] = fn(copy[idx])
        return copy
      })
    }

    // 流式增量缓冲（正文/思考的合并窗口与撤回判定见 lib/stream-buffer，那边可单测）
    const streamCtx = new StreamBuffer()

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId: sessionIdRef.current, spaceId: activeSpaceId || undefined, attachments: sentAttachments, contextSessionId: refSessionId || undefined, runId }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`请求失败（HTTP ${res.status}）`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let event = ''

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
            handleSseEvent(event, data, patchAssistant, streamCtx)
            event = ''
          }
        }
      }
      // 流正常结束却没等到 result（服务端重启/连接被中间层掐断）：必须给气泡收尾，
      // 否则它会永远停在「生成中」，用户看到的就是「对话不再更新」
      patchAssistant((m) =>
        m.running ? { ...m, running: false, error: true, content: m.content || '（连接中断，未收到结果；请重发或刷新页面）' } : m,
      )
      void refreshSessions()
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 主动「停止」同样要收尾，不然也是永久「生成中」
        patchAssistant((m) => (m.running ? { ...m, running: false, content: m.content || '（已停止）' } : m))
      } else {
        setError(err instanceof Error ? err.message : String(err))
        patchAssistant((m) => ({ ...m, running: false, content: m.content || '（发生错误）', error: true }))
      }
    } finally {
      // 异常与中断路径同样要把没到点的缓冲写回，否则最后一段会随流一起丢
      streamCtx.flushTokens(patchAssistant)
      streamCtx.flushThinking(patchAssistant)
      setRunning(false)
      abortRef.current = null
      runIdRef.current = ''
    }
  }

  function handleSseEvent(
    event: string,
    data: Record<string, unknown>,
    patchAssistant: (fn: (m: ChatMessage) => ChatMessage) => void,
    streamCtx: StreamBuffer,
  ) {
    switch (event) {
      case 'session':
        // 会话 id 前置（服务端在开跑前就建好会话）：立刻记下归属并持久化，
        // 首条消息生成期间刷新也能回到该会话、把「停止」补挂回去。
        if (data.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = String(data.sessionId)
          rememberLastSession(sessionIdRef.current)
        }
        break
      case 'step':
        // 每个 step 开始：清空本步的过程内容缓冲，独立累积
        streamCtx.nextStep()
        patchAssistant((m) => ({
          ...m,
          trace: [...(m.trace ?? []), { type: 'step', step: Number(data.step) }],
        }))
        break
      case 'tool': {
        // 本步调用工具：说明这段文字其实是「过程性描述」——从结论里撤回，改归入思考。
        // token 现在是实时上屏的，所以必须显式撤回（旧实现只往缓冲里攒，撤回这步不存在）。
        // 先补齐还压在上屏缓冲里的正文：下面的 endsWith 判断依赖 m.content 以本步正文结尾。
        streamCtx.flushTokens(patchAssistant)
        const desc = streamCtx.takeCurContent()
        if (desc) {
          patchAssistant((m) => {
            const content = m.content ?? ''
            const trimmed = content.endsWith(desc) ? content.slice(0, content.length - desc.length) : content
            return { ...m, content: trimmed, thinking: [m.thinking, desc].filter(Boolean).join('\n\n') }
          })
        }
        patchAssistant((m) => ({
          ...m,
          trace: [
            ...(m.trace ?? []),
            {
              type: 'tool',
              toolName: String(data.name ?? ''),
              toolArgs: data.args ? JSON.stringify(data.args).slice(0, 200) : '',
            },
          ],
        }))
        break
      }
      case 'tool_result':
        patchAssistant((m) => {
          const trace = [...(m.trace ?? [])]
          for (let i = trace.length - 1; i >= 0; i--) {
            if (trace[i].type === 'tool' && trace[i].toolName === data.name) {
              trace[i] = { ...trace[i], toolResult: summarize(data.result) }
              break
            }
          }
          return { ...m, trace }
        })
        break
      case 'thinking': {
        // 合并窗口内累积，到点一次性写回（理由见 STREAM_THINK_FLUSH_MS）
        streamCtx.pushThinking(String(data.text ?? ''), patchAssistant)
        break
      }
      case 'token':
        // 实时上屏（打字机效果），同时保留缓冲：本步若调用工具，这段文字会在 'tool' 事件里
        // 被撤回并归入「思考」；否则它就是结论正文。
        // 只缓冲不上屏的旧做法会让长回答一直停在骨架动画上，最后整段「啪」地出现。
        // 但上屏要走合并窗口（理由见 STREAM_TOKEN_FLUSH_MS）；curContent 必须同步累积，
        // 撤回判定读的是它，不能等到定时器才更新。
        streamCtx.pushToken(String(data.text ?? ''), patchAssistant)
        break
      case 'result': {
        // 交付结束：只在此把最终答复写入「结论」，并用 result.content 权威覆盖
        streamCtx.flushTokens(patchAssistant)
        streamCtx.flushThinking(patchAssistant)
        const finalContent = String(data.content ?? '') || streamCtx.curContent
        streamCtx.nextStep()
        sessionIdRef.current = String(data.sessionId ?? '')
        patchAssistant((m) => ({
          ...m,
          content: finalContent,
          running: false,
          steps: Number(data.steps ?? 0),
          finishedReason: String(data.finishedReason ?? ''),
          sessionId: String(data.sessionId ?? ''),
        }))
        break
      }
      case 'error':
        // 先把已产出的正文补上屏，错误信息才会接在正文之后而不是插到中间
        streamCtx.flushTokens(patchAssistant)
        streamCtx.flushThinking(patchAssistant)
        patchAssistant((m) => ({ ...m, running: false, content: `${m.content ?? ''}\n[错误] ${String(data.message ?? '')}`, error: true }))
        break
    }
  }

  /**
   * 会话树分组（父 → 子）与顶层列表。
   *
   * 这段计算只依赖 sessions，但原先写在 JSX 的 IIFE 里，每次渲染都要重跑一遍：
   * 流式期间每个 token 都会触发一次根组件渲染，于是「分组 + 顶层过滤 + 展开」被白算成百上千次。
   * 顶层过滤原先是 `sessions.some(...)`（O(n²)），这里先用 Set 建索引降到 O(n)。
   */
  const sessionTree = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.id))
    const childrenByParent = new Map<string, SessionItem[]>()
    for (const s of sessions) {
      // 父会话不在列表里（已删除/未加载）的孤立子会话不进分组，直接按顶层渲染——
      // 与原先「分组键指向不存在的父」时的可见结果一致，只是不再留下永远渲染不到的死键
      if (!s.parentId || !ids.has(s.parentId)) continue
      const arr = childrenByParent.get(s.parentId) ?? []
      arr.push(s)
      childrenByParent.set(s.parentId, arr)
    }
    return { childrenByParent, topLevel: sessions.filter((s) => !s.parentId || !ids.has(s.parentId)) }
  }, [sessions])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void handleDrop(e)
      }}
    >
      {dragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-inner">
            <span className="drag-overlay-icon"><Icon name="paperclip" size={40} /></span>
            <span>松开鼠标：文件生成链接 · 图片作为附件</span>
          </div>
        </div>
      )}
      <aside className={`sidebar${railCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-header">
          <span className="brand" title="筑星 Harness">
            <span className="brand-name">筑星 Harness</span>
          </span>
          <button
            className="icon-btn rail-collapse"
            onClick={() => setRailCollapsed((v) => !v)}
            title={railCollapsed ? '展开侧栏' : '收起为图标轨'}
            aria-label={railCollapsed ? '展开侧栏' : '收起为图标轨'}
            aria-expanded={!railCollapsed}
          >
            <Icon name={railCollapsed ? 'chevron-right' : 'chevron-left'} />
          </button>
        </div>

        <div className="sidebar-scope">
          <select
            className="space-select"
            value={showArchived ? '__archived' : activeSpaceId}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__archived') {
                if (!showArchived) toggleArchived()
                return
              }
              if (showArchived) {
                setShowArchived(false)
                setMessages([])
                setError('')
                sessionIdRef.current = undefined
              }
              handleSelectSpace(v)
            }}
            title="切换空间（项目）"
          >
            <option value="">默认空间</option>
            {spaces.map((sp) => (
              <option key={sp.id} value={sp.id}>{sp.title}</option>
            ))}
            <option value="__archived">已归档对话</option>
          </select>
          <button className="icon-btn" onClick={() => void handleNewSpace()} title="新建空间" aria-label="新建空间">
            <Icon name="plus" />
          </button>
          {activeSpaceId !== '' && !showArchived && (
            <button
              className="icon-btn danger"
              onClick={() => void handleDeleteSpace(activeSpaceId)}
              title="删除当前空间"
              aria-label="删除当前空间"
            >
              <Icon name="trash" />
            </button>
          )}
        </div>

        <button className="btn new-chat" onClick={newChat} title="新对话">
          <Icon name="plus" />
          <span className="btn-label">新对话</span>
        </button>
        <div className="session-list">
          {(() => {
            const { childrenByParent, topLevel } = sessionTree
            const renderItem = (s: SessionItem, isChild: boolean) => (
              <div
                key={s.id}
                className={`session-item ${isChild ? 'child' : ''} ${sessionIdRef.current === s.id ? 'active' : ''}`}
                onDoubleClick={() => beginRename(s)}
                title="双击重命名"
              >
                {editingSessionId === s.id ? (
                  <input
                    className="session-title-input"
                    value={editingTitle}
                    autoFocus
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void renameCurrentSession(s.id)
                      } else if (e.key === 'Escape') {
                        setEditingSessionId(null)
                      }
                    }}
                    onBlur={() => void renameCurrentSession(s.id)}
                  />
                ) : (
                  <button className="session-open" onClick={() => void openSession(s.id)}>
                    <div className="session-title">
                      {isChild && <span className="child-mark">⤷ </span>}
                      {s.title || s.preview || s.id.slice(0, 12)}
                    </div>
                    {/* 只留时间：事件数是开发者视角的指标，用户不关心 */}
                    <div className="session-meta">
                      {s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : ''}
                    </div>
                  </button>
                )}
                <div className="session-actions">
                  {s.archived ? (
                    <button className="sa-btn" onClick={() => void handleRestore(s.id)} title="恢复" aria-label="恢复">
                      <Icon name="undo" />
                    </button>
                  ) : (
                    <button className="sa-btn" onClick={() => void handleArchive(s.id)} title="归档" aria-label="归档">
                      <Icon name="archive" />
                    </button>
                  )}
                  <button className="sa-btn danger" onClick={() => void handleDelete(s.id)} title="删除" aria-label="删除">
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            )
            return topLevel.flatMap((s) => [
              renderItem(s, false),
              ...(childrenByParent.get(s.id) ?? []).map((c) => renderItem(c, true)),
            ])
          })()}
          {sessions.length === 0 && (
            <div className="empty-hint">
              {showArchived
                ? '还没有归档的对话。归档后的对话会集中在这里。'
                : '还没有对话。在下方描述一个任务，我就会开始。'}
            </div>
          )}
        </div>
        <div className="sidebar-foot">
          <button
            className={`rail-btn nav-knowledge${page === 'knowledge' ? ' active' : ''}`}
            onClick={() => morph(() => setPage('knowledge'), 'knowledge')}
            title="知识库"
          >
            <Icon name="book" />
            <span className="rail-label">知识库</span>
          </button>
          <button
            className="rail-btn nav-settings"
            onClick={() => morph(() => setShowSettings(true), 'settings')}
            title="设置"
          >
            <Icon name="sliders" />
            <span className="rail-label">设置</span>
          </button>
          <button className="rail-btn" onClick={toggleTheme} title="切换主题">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            <span className="rail-label">{theme === 'dark' ? '浅色' : '暗色'}</span>
          </button>
        </div>
      </aside>

      {page === 'knowledge' ? (
        <KnowledgePage config={config} onSave={saveConfigPatch} onToast={showToast} onBack={() => morph(() => setPage('chat'))} />
      ) : (
      <main className="main">
        <header className="topbar">
          <span className="topbar-title">
            {messages.length === 0
              ? '新对话'
              : (sessions.find((s) => s.id === sessionIdRef.current)?.title
                || sessions.find((s) => s.id === sessionIdRef.current)?.preview
                || '当前对话')}
          </span>
          {config.model && <span className="model-badge">{config.model}</span>}
        </header>

        {/* 流式回答对读屏软件原本完全静默：live region 加在列表容器上，
            不落到逐 token 变化的元素，避免每个 token 都触发一次朗读。 */}
        <div
          className="messages"
          ref={messagesRef}
          onScroll={handleMessagesScroll}
          data-empty={messages.length === 0 ? 'true' : undefined}
          role="log"
          aria-live="polite"
          aria-label="对话消息"
        >
          {messages.length === 0 && (
            config.apiKey ? (
              <div className="welcome">
                <div className="welcome-kicker">筑星 Harness · Agent 运行时</div>
                <h2>你好，<br />我是筑星 Harness</h2>
                <p>可随意接入插件的 Agent 运行时。直接下达任务，我会调用工具完成对话、工作与交付。</p>
                <div className="suggestions">
                  {['总结当前目录结构', '调用 hello 工具打个招呼', '阅读 README.md 并总结'].map((s, i) => (
                    <button key={s} className="chip" onClick={() => setInput(s)}>
                      <span className="chip-idx">{String(i + 1).padStart(2, '0')}</span>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="setup-guide">
                <div className="setup-copy">
                  <div className="setup-kicker">首次使用</div>
                  <h2>先连接你的模型</h2>
                  <p>配置 API Key 和模型后，即可开始对话、执行任务并获得交付结果。</p>
                  <button className="btn primary setup-btn" onClick={() => setShowSettings(true)}>
                    打开设置
                    <Icon name="chevron-right" size={15} />
                  </button>
                </div>
                <ol className="setup-steps">
                  <li>
                    <span className="step-idx">01</span>
                    <span className="step-title">填入 API Key</span>
                    <span className="step-desc">设置 → 模型 → 主模型</span>
                  </li>
                  <li>
                    <span className="step-idx">02</span>
                    <span className="step-title">选择模型名</span>
                    <span className="step-desc">默认用它理解任务、调用工具</span>
                  </li>
                  <li>
                    <span className="step-idx">03</span>
                    <span className="step-title">回到这里下任务</span>
                    <span className="step-desc">在下方输入框描述目标即可</span>
                  </li>
                </ol>
              </div>
            )
          )}
          {messages.map((m) => (
            <MemoMessageBubble
              key={m.id}
              msg={m}
              onPreview={(path, line) => setPreviewTarget({ path, line })}
              onFork={sessionIdRef.current ? () => void handleFork(sessionIdRef.current!) : undefined}
            />
          ))}
          {error && <div className="error-banner" role="alert"><Icon name="alert" /> {error}</div>}
          {!autoScroll && messages.length > 0 && (
            <button className="jump-latest" onClick={jumpToLatest}>
              <Icon name="chevron-down" /> 新消息
            </button>
          )}
          <div ref={bottomRef} />
        </div>

        <div className={`composer${dragging ? ' dragging' : ''}`}>
          {(fileLinks.length > 0 || attachments.length > 0) && (
            <div className="attach-row">
              {fileLinks.map((f) => (
                <span key={f.path} className="attach-chip file" title={f.path}>
                  <a onClick={() => setPreviewTarget({ path: f.path })}>{f.name}</a>
                  <button
                    className="chip-x"
                    aria-label="移除文件"
                    onClick={() => setFileLinks((prev) => prev.filter((x) => x.path !== f.path))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
              {attachments.map((_a, i) => (
                <span key={i} className="attach-chip image">
                  <Icon name="image" /> 图片 {i + 1}
                  <button
                    className="chip-x"
                    aria-label="移除图片"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                void send()
              } else if (isSubmitEnter(e) && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="输入任务描述，可拖入文件/图片；Enter 发送 / Shift+Enter 换行"
            rows={2}
            disabled={running}
          />
          <div className="composer-bar">
            <div className="composer-tools">
              {/* 只有图标：title 不足以作为无障碍名，补 aria-label */}
              <button className="icon-btn" title="选择文件（可多选）" aria-label="选择文件（可多选）" onClick={() => fileInputRef.current?.click()}>
                <Icon name="paperclip" />
              </button>
              <button className="icon-btn" title="选择整个文件夹导入" aria-label="选择整个文件夹导入" onClick={() => folderInputRef.current?.click()}>
                <Icon name="folder-open" />
              </button>
              <input
                ref={fileInputRef}
                className="file-input"
                type="file"
                multiple
                onChange={(e) => handleSelectFiles(e.target.files, false)}
              />
              <input
                ref={folderInputRef}
                className="file-input"
                type="file"
                multiple
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(e) => handleSelectFiles(e.target.files, true)}
              />
              <select
                className="ref-select"
                value={refSessionId}
                onChange={(e) => setRefSessionId(e.target.value)}
                title="选择要作为参考上下文的对话（注入其记录与私有记忆）"
              >
                <option value="">不加参考对话</option>
                {sessions
                  .filter((s) => s.id !== sessionIdRef.current)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.preview || `对话 ${String(s.id).slice(0, 8)}`}
                    </option>
                  ))}
              </select>
            </div>
            {running ? (
              <button
                className="btn stop-btn"
                onClick={handleStop}
              >
                <Icon name="stop" /> 停止
              </button>
            ) : (
              <button
                className="btn send-btn"
                onClick={() => void send()}
                disabled={!input.trim() && fileLinks.length === 0 && attachments.length === 0}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </main>
      )}

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            config={config}
            onSave={saveConfigPatch}
            onToast={showToast}
            onClose={() => morph(() => setShowSettings(false), 'settings')}
          />
        </Suspense>
      )}
      {previewTarget && (
        <Suspense fallback={null}>
          <FilePreview
            path={previewTarget.path}
            line={previewTarget.line}
            onClose={() => morph(() => setPreviewTarget(null), 'preview')}
          />
        </Suspense>
      )}
      {subChat && (
        <SubChatWindow
          subChat={subChat}
          onClose={() => morph(() => setSubChat(null), 'subchat')}
          onMerged={(parentId) => void handleMerged(parentId)}
          onPreview={(path, line) => setPreviewTarget({ path, line })}
        />
      )}
      {/* 工作区面板（终端 + 网页预览）：自带开关，不改动既有布局 */}
      <WorkspaceDock messages={messages} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function MessageBubble({ msg, onPreview, onFork }: { msg: ChatMessage; onPreview: PreviewHandler; onFork?: () => void }) {
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {msg.content}
          {msg.images && msg.images.length > 0 && (
            <div className="bubble-imgs">
              {msg.images.map((src, i) => (
                <img key={i} src={src} alt={`附件 ${i + 1}`} className="bubble-img" />
              ))}
            </div>
          )}
        </div>
        {onFork && (
          <div className="msg-actions">
            <button className="btn-link" onClick={onFork}>分叉</button>
          </div>
        )}
      </div>
    )
  }
  if (msg.role === 'assistant') {
    return (
      <div className="msg assistant">
        <div className={`bubble ${msg.error ? 'err' : ''}`}>
          <TraeAssistant msg={msg} onPreview={onPreview} />
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
        {onFork && (
          <div className="msg-actions">
            <button className="btn-link" onClick={onFork}>分叉</button>
          </div>
        )}
      </div>
    )
  }
  return null
}

/**
 * memo 化的消息气泡。
 *
 * 比较函数刻意只看 msg 本身：onPreview / onFork 是内联箭头函数，每次渲染都是新引用，
 * 用默认的浅比较等于白 memo。msg 全程走不可变更新（内容变了就是新对象），
 * 所以「引用相同 = 内容未变」成立；另外 onFork 的有无要参与比较，否则会话 id 出现后按钮不刷新。
 */
const MemoMessageBubble = memo(
  MessageBubble,
  (prev, next) => prev.msg === next.msg && Boolean(prev.onFork) === Boolean(next.onFork),
)

/** Trae 风格助手消息：顶部统计 → 三份并列结构（调用 / 临时说明 / 结论），过程性内容独立成块，不污染结论。 */
function TraeAssistant({ msg, onPreview }: { msg: ChatMessage; onPreview: PreviewHandler }) {
  const running = msg.running === true
  // 默认一律收起（运行中也收起）：过程细节不该默认铺满屏幕，用户点了才展开、才渲染。
  // 实时反馈交给「调用」折叠标题里的「进行中…」，它不依赖展开状态。
  const [traceOpen, setTraceOpen] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const trace = msg.trace ?? []
  const stepCount = trace.filter((t) => t.type === 'step').length
  const toolCount = trace.filter((t) => t.type === 'tool').length
  const hasTrace = stepCount > 0 || toolCount > 0
  const thinking = msg.thinking ?? ''
  const brief = msg.brief ?? ''
  const content = msg.content ?? ''
  // 展开「调用」时也只渲染最近若干条：一次长任务可能有几十次工具调用，
  // 全量渲染既拖慢主线程，也会把真正要看的结论挤下去。
  const TRACE_SHOWN = 15
  const traceStart = Math.max(0, trace.length - TRACE_SHOWN)
  const traceShown = trace.slice(traceStart)
  // 流式期间（running）对 thinking 只渲染前缀预览，避免超长推理内容每收一个 token 都全量重解析，
  // 否则渐增大文本 × 频繁重渲染 = O(n²)，会让浏览器渲染进程内存耗尽（Out of Memory）。
  const THINKING_PREVIEW_MAX = 2000
  // 展开时对超长推理也留一个上限：单次渲染几十万字同样会卡住主线程
  const THINKING_RENDER_MAX = 20_000
  const thinkingRaw = running && thinking.length > THINKING_PREVIEW_MAX ? `${thinking.slice(0, THINKING_PREVIEW_MAX)}…` : thinking
  const thinkingShown =
    thinkingRaw.length > THINKING_RENDER_MAX ? `${thinkingRaw.slice(0, THINKING_RENDER_MAX)}\n\n…（已省略 ${thinkingRaw.length - THINKING_RENDER_MAX} 字）` : thinkingRaw

  return (
    <div className="trae-asst">
      {/* 步数 / 工具次数是开发者视角的指标，不常驻消息顶部：并入「调用」折叠标题。
          进行中反馈保留：已有调用记录时挂在标题上，还没有记录时单独占一行。 */}
      {running && !hasTrace && (
        <div className="trae-stats">
          <span className="trace-running">进行中…</span>
        </div>
      )}

      {/* 任务书：本轮执行前对用户指令的结构化改写（目标/交付物/约束/验收/步骤），默认收起 */}
      {brief && (
        <div className="trae-section">
          <button className="trae-section-toggle" onClick={() => setBriefOpen(!briefOpen)} aria-expanded={briefOpen}>
            <span className="trae-section-name">任务书</span>
            <span className="trae-caret">{briefOpen ? '▾' : '▸'}</span>
          </button>
          {briefOpen && (
            <div className="trae-thinking-body">
              <Markdown text={brief} onPreview={onPreview} />
            </div>
          )}
        </div>
      )}

      {/* 调用：工具命令与回复过程 */}
      {hasTrace && (
        <div className="trae-section">
          <button className="trae-section-toggle" onClick={() => setTraceOpen(!traceOpen)} aria-expanded={traceOpen}>
            <span className="trae-section-name">
              {`调用（${stepCount} 步 · ${toolCount} 次工具${running ? ' · 进行中…' : ''}）`}
            </span>
            <span className="trae-caret">{traceOpen ? '▾' : '▸'}</span>
          </button>
          {traceOpen && (
            <div className="trae-tools">
              {traceStart > 0 && (
                <div className="trae-step">
                  <span className="trae-step-label">更早的 {traceStart} 条已省略</span>
                </div>
              )}
              {traceShown.map((item, i) =>
                item.type === 'step' ? (
                  <div key={traceStart + i} className="trae-step">
                    <span className="trae-step-idx">第 {item.step} 步</span>
                    <span className="trae-step-label">调用模型</span>
                  </div>
                ) : (
                  <div key={traceStart + i} className="trae-tool">
                    <div className="trae-tool-name"><Icon name="terminal" /> {item.toolName}</div>
                    {item.toolArgs && <div className="trae-tool-args">{item.toolArgs}</div>}
                    {item.toolResult !== undefined && (
                      <div className={`trae-tool-result ${item.toolResult.startsWith('错误') ? 'err' : ''}`}>{item.toolResult}</div>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {/* 临时说明：过程性思考，独立成块，避免污染结论 */}
      {thinking && (
        <div className="trae-section">
          <button className="trae-section-toggle" onClick={() => setThinkingOpen(!thinkingOpen)} aria-expanded={thinkingOpen}>
            <span className="trae-section-name">
              {`临时说明（${
                thinking.length >= 1000 ? `${(thinking.length / 1000).toFixed(1)}k` : thinking.length
              } 字）`}
            </span>
            <span className="trae-caret">{thinkingOpen ? '▾' : '▸'}</span>
          </button>
          {thinkingOpen && <div className="trae-thinking-body"><Markdown text={thinkingShown} onPreview={onPreview} /></div>}
        </div>
      )}

      {/* 结论：最终回复；存在调用/临时说明时带「结论」标签，纯文本消息直接展示 */}
      {(hasTrace || thinking) && (content || msg.error) && (
        <div className="trae-conclusion">
          <span className="trae-conclusion-label">结论</span>
          <AssistantContent msg={msg} onPreview={onPreview} />
        </div>
      )}
      {!hasTrace && !thinking && (content || msg.error) && (
        <AssistantContent msg={msg} onPreview={onPreview} />
      )}
    </div>
  )
}

/** 助手内容：正文始终完整渲染，不做字符级截断。
 *  流式期间传 foldLimit=null（内容随生成增长，不冻结）；
 *  仅当已结束且块数超阈值时才折叠，且截断点由渲染引擎保证落在块边界。 */
function AssistantContent({ msg, onPreview }: { msg: ChatMessage; onPreview: PreviewHandler }) {
  const content = msg.content ?? ''
  const isRunning = msg.running === true
  const hasTrace = (msg.trace?.length ?? 0) > 0
  if (content) {
    return (
      <div className="assistant-content">
        <Markdown text={content} onPreview={onPreview} foldLimit={isRunning ? null : FOLD_BLOCK_LIMIT} />
      </div>
    )
  }
  if (isRunning && !hasTrace) {
    return (
      <div className="assistant-skeleton" aria-label="正在生成回复">
        <span />
        <span />
        <span />
      </div>
    )
  }
  return null
}


/** 独立子对话窗口：继承父会话历史，独立演进，可合并结论回主对话。 */
function SubChatWindow({
  subChat,
  onClose,
  onMerged,
  onPreview,
}: {
  subChat: { sessionId: string; parentId: string }
  onClose: () => void
  onMerged: (parentId: string) => void
  onPreview: PreviewHandler
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [merging, setMerging] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** 本轮对话的服务端 runId：点「停止」时带着它请求服务端取消。 */
  const runIdRef = useRef('')

  const loadEvents = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/events`)
    if (!res.ok) return
    const data = (await res.json()) as { events: Array<{ type: string; payload: unknown }> }
    setMessages(rebuildMessages(data.events, undefined, nextId))
  }, [])

  useEffect(() => {
    void loadEvents(subChat.sessionId)
    // 子会话补挂：与主对话同一套逻辑——刷新或重开窗口后，
    // 按 sessionId 去 /api/chat/active 匹配仍在跑的轮次，把「停止」挂回去。
    void (async () => {
      const runs = await listActiveRuns()
      const hit = runs.find((r) => r.sessionId === subChat.sessionId)
      if (!hit) return
      runIdRef.current = hit.runId
      setRunning(true)
    })()
  }, [subChat.sessionId, loadEvents])

  async function send() {
    const message = input.trim()
    if (!message || running) return
    setInput('')
    setRunning(true)
    const userMsg: ChatMessage = { id: nextId(), role: 'user', content: message }
    const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', running: true }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    const controller = new AbortController()
    abortRef.current = controller
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    runIdRef.current = runId
    const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsg.id)
        if (idx < 0) return prev
        const copy = [...prev]
        copy[idx] = fn(copy[idx])
        return copy
      })
    }
    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionId: subChat.sessionId, runId }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`请求失败（HTTP ${res.status}）`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let event = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            // 坏帧跳过，理由同主对话：一行噪声不该让整轮问答变成「发生错误」
            let data: Record<string, unknown>
            try {
              data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
            } catch {
              continue
            }
            if (event === 'token') patchAssistant((m) => ({ ...m, content: `${m.content ?? ''}${String(data.text ?? '')}` }))
            else if (event === 'result') {
              patchAssistant((m) => ({ ...m, running: false, steps: Number(data.steps ?? 0), finishedReason: String(data.finishedReason ?? '') }))
            } else if (event === 'error') {
              patchAssistant((m) => ({ ...m, running: false, content: `${m.content ?? ''}\n[错误] ${String(data.message ?? '')}`, error: true }))
            }
            event = ''
          }
        }
      }
      // 与主对话一致：流结束却没等到 result 时必须收尾，否则永久停在「生成中」
      patchAssistant((m) => (m.running ? { ...m, running: false, error: true, content: m.content || '（连接中断，未收到结果）' } : m))
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        patchAssistant((m) => (m.running ? { ...m, running: false, content: m.content || '（已停止）' } : m))
      } else {
        patchAssistant((m) => ({ ...m, running: false, content: m.content || '（发生错误）', error: true }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      runIdRef.current = ''
    }
  }

  async function doMerge() {
    if (merging) return
    setMerging(true)
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const summary = (lastAssistant?.content ?? '').slice(0, 500)
    const ok = await mergeSession(subChat.parentId, subChat.sessionId, summary)
    setMerging(false)
    if (ok) onMerged(subChat.parentId)
  }

  return (
    <div className="subchat-window">
      <header className="subchat-head">
        <span className="subchat-title">子对话（分叉自 {subChat.parentId.slice(0, 8)}）</span>
        <div className="subchat-head-actions">
          <button className="btn-link" onClick={() => void doMerge()} disabled={merging}>
            {merging ? '合并中…' : '合并回主对话'}
          </button>
          <button className="btn-link" onClick={onClose}>关闭</button>
        </div>
      </header>
      <div className="subchat-messages">
        {messages.map((m) => (
          <MemoMessageBubble key={m.id} msg={m} onPreview={onPreview} />
        ))}
        {messages.length === 0 && <div className="empty-hint">子对话已继承主对话历史，可在此独立探索。</div>}
      </div>
      <div className="subchat-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 与主输入框同规则：中文输入法选词的回车不算发送
            if (isSubmitEnter(e) && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="子对话输入，Enter 发送 / Shift+Enter 换行"
          rows={2}
          disabled={running}
        />
        {running ? (
          <button
            className="btn stop-btn"
            onClick={() => {
              void stopChatRun(runIdRef.current)
              if (abortRef.current) {
                // 本窗口发起的流：断本地连接，由 send() 的 finally 复位并收尾
                abortRef.current.abort()
              } else {
                // 补挂的轮次（刷新后挂上来的，本窗口没有本地流）：
                // 服务端已停，这里自行复位状态并重新拉一次事件呈现停止点。
                runIdRef.current = ''
                setRunning(false)
                void loadEvents(subChat.sessionId)
              }
            }}
          ><Icon name="stop" /> 停止</button>
        ) : (
          <button className="btn send-btn" onClick={() => void send()} disabled={!input.trim()}>发送</button>
        )}
      </div>
    </div>
  )
}

/** 知识库设置面板：开关 + embedding 配置 + 检索作用域 / topK（置于知识库页右上角 ··· 内）。 */
function KnowledgeSettingsPanel({
  config,
  onSave,
}: {
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
}) {
  const k = config.knowledge
  const [kbEnabled, setKbEnabled] = useState(k?.enabled ?? false)
  const [kbBaseUrl, setKbBaseUrl] = useState(k?.embedding?.baseUrl ?? '')
  const [kbApiKey, setKbApiKey] = useState(k?.embedding?.apiKey ?? '')
  const [kbModel, setKbModel] = useState(k?.embedding?.model ?? 'text-embedding-3-small')
  const [kbScope, setKbScope] = useState<'' | 'global' | 'workspace'>(k?.scope ?? 'global')
  const [kbTopK, setKbTopK] = useState(k?.topK ?? 4)
  const [saving, setSaving] = useState(false)

  const persistConfig = () => {
    setSaving(true)
    onSave({
      knowledge: {
        enabled: kbEnabled,
        scope: (kbScope || 'global') as 'global' | 'workspace',
        topK: kbTopK,
        embedding: kbEnabled && (kbBaseUrl || kbApiKey)
          ? { baseUrl: kbBaseUrl || undefined, apiKey: kbApiKey || undefined, model: kbModel || undefined }
          : undefined,
      },
    })
    setTimeout(() => setSaving(false), 600)
  }

  return (
    <div className="sub-model-card mb-3">
      <div className="sub-model-head">
        <span className="sub-idx">启用知识库</span>
        <button className="btn" onClick={persistConfig} disabled={saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
      <label className="field checkbox-field">
        <span>启用 RAG 注入</span>
        <input type="checkbox" checked={kbEnabled} onChange={(e) => setKbEnabled(e.target.checked)} />
      </label>
      <p className="section-hint">启用后在对话中输入 <code>search_knowledge</code> 工具（AI 可自动调用）即可检索知识库。</p>
      <div className="field-row">
        <label className="field">
          <span>Embedding Base URL（OpenAI 兼容 /embeddings）</span>
          <input value={kbBaseUrl} placeholder="https://api.deepseek.com/v1" onChange={(e) => setKbBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Embedding API Key</span>
          <input type="password" value={kbApiKey} placeholder="留空 = 降级关键词" onChange={(e) => setKbApiKey(e.target.value)} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Embedding 模型</span>
          <input value={kbModel} placeholder="text-embedding-3-small" onChange={(e) => setKbModel(e.target.value)} />
        </label>
        <label className="field">
          <span>检索作用域</span>
          <select value={kbScope} onChange={(e) => setKbScope(e.target.value as '' | 'global' | 'workspace')}>
            <option value="global">global（全局共享）</option>
            <option value="workspace">workspace（工作区隔离）</option>
          </select>
        </label>
        <label className="field">
          <span>命中条数（topK）</span>
          <input type="number" value={kbTopK} onChange={(e) => setKbTopK(Number(e.target.value) || 4)} />
        </label>
      </div>
    </div>
  )
}

/** 上传知识文档面板（置于知识库设置弹层内，自带空间/目录选择，入库后通知外部刷新列表）。
 *  标题由外层的折叠开关承担，此处不再重复渲染。 */
function KnowledgeUploadPanel({
  onToast,
  onUploaded,
}: {
  onToast: (message: string) => void
  onUploaded: () => void
}) {
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([])
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [defaultSpaceId, setDefaultSpaceId] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [folderId, setFolderId] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetchKnowledgeSpaces('global')
        if (cancelled) return
        setSpaces(r.spaces)
        setDefaultSpaceId(r.defaultSpaceId ?? '')
        setSpaceId((prev) => prev || r.defaultSpaceId || r.spaces[0]?.id || '')
      } catch {
        /* 空间加载失败不阻塞上传 */
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!spaceId) { setFolders([]); return }
      try {
        const f = await fetchKnowledgeFolders(spaceId, 'global')
        if (!cancelled) setFolders(f)
      } catch {
        if (!cancelled) setFolders([])
      }
    })()
    return () => { cancelled = true }
  }, [spaceId])

  const currentSpace = spaces.find((s) => s.id === spaceId)
  const currentFolder = folders.find((f) => f.id === folderId)

  const doUpload = async () => {
    if (!text.trim() && !files.length) {
      setError('请粘贴文本或选择文件（txt/md/csv/json/yaml/code 及 docx/pptx/xlsx）。')
      return
    }
    setUploading(true)
    setError('')
    try {
      const filePayload = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await fileToBase64(f) })))
      const added = await uploadKnowledge({
        scope: 'global',
        title: title.trim() || undefined,
        tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        spaceId: spaceId || undefined,
        folderId: folderId || null,
        text: text.trim() || undefined,
        files: filePayload.length ? filePayload : undefined,
      })
      setText('')
      setTitle('')
      setTags('')
      setFiles([])
      onToast(`已入库 ${added.added.length} 个文档`)
      onUploaded()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    // 卡片外壳由弹窗里的折叠块提供，这里只输出内容，避免卡片套卡片
    <>
      <div className="meta mb-2">
        归档到：空间「{currentSpace?.name ?? '默认'}」 / 目录「{currentFolder ? currentFolder.name : '根目录'}」
      </div>
      <div className="field-row">
        <label className="field grow">
          <span>归档空间</span>
          <select value={spaceId} onChange={(e) => { setSpaceId(e.target.value); setFolderId('') }}>
            {spaces.length === 0 && <option value="">加载中…</option>}
            {spaces.map((s) => <option key={s.id} value={s.id}>{s.builtin ? '★ ' : ''}{s.name}{s.id === defaultSpaceId ? '（默认）' : ''}</option>)}
          </select>
        </label>
        <label className="field">
          <span>目录</span>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">根目录</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field grow">
          <span>标题（可选）</span>
          <input value={title} placeholder="如 建筑施工规范" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>标签（逗号分隔）</span>
          <input value={tags} placeholder="规范, 建筑" onChange={(e) => setTags(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>文本内容（可直接粘贴）</span>
        <textarea value={text} placeholder="粘贴要入库的文本…" onChange={(e) => setText(e.target.value)} rows={3} />
      </label>
      <label className="field">
        <span>文件（txt/md/csv/json/yaml/code 及 docx/pptx/xlsx）</span>
        <input
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.yaml,.yml,.js,.ts,.tsx,.py,.java,.c,.cpp,.sql,.html,.css,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
      </label>
      {files.length > 0 && <div className="file-list">已选：{files.map((f) => f.name).join('、')}</div>}
      <button className="btn primary" onClick={() => void doUpload()} disabled={uploading}>
        {uploading ? '入库中…' : '上传入库'}
      </button>
      {error && <InlineError>{error}</InlineError>}
    </>
  )
}

/** 自生长知识库配置面板：开关 + embedding 配置 + 文档管理（上传 / 列表 / 删除 / 重建索引）。 */
function KnowledgePanel({
  onToast,
  config,
  onSave,
  settingsOpen,
  onCloseSettings,
}: {
  onToast: (message: string) => void
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
  settingsOpen: boolean
  onCloseSettings: () => void
}) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [hasEmbedding, setHasEmbedding] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [q, setQ] = useState('')
  const [listScope, setListScope] = useState<'global' | 'workspace'>('global')
  const [loading, setLoading] = useState(false)

  // 知识库设置弹窗可达性：Esc 关闭、打开时移入焦点、关闭后归还焦点。
  // onCloseSettings 由父组件内联传入（每次渲染重建），包一层稳定引用避免监听与焦点还原被反复重绑。
  const onCloseSettingsRef = useRef(onCloseSettings)
  onCloseSettingsRef.current = onCloseSettings
  const closeSettings = useCallback(() => onCloseSettingsRef.current(), [])
  const settingsModalRef = useModalA11y(settingsOpen, closeSettings)

  // 上传面板挂载即请求空间/目录：默认收起，切到这一区才挂载，开弹窗不会顺手多打两个请求
  const [uploadOpen, setUploadOpen] = useState(false)

  // 多知识空间 / 目录树
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([])
  const [defaultSpaceId, setDefaultSpaceId] = useState('')
  const [currentSpaceId, setCurrentSpaceId] = useState('')
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [currentFolderId, setCurrentFolderId] = useState('') // '' = 空间内全部
  const [newSpaceName, setNewSpaceName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')

  // 知识库问答（带溯源）
  const [qaQuestion, setQaQuestion] = useState('')
  const [qaAnswer, setQaAnswer] = useState('')
  const [qaHits, setQaHits] = useState<KnowledgeHit[]>([])
  const [qaLoading, setQaLoading] = useState(false)
  const [qaError, setQaError] = useState('')

  // 移动词条
  const [movingId, setMovingId] = useState('')
  const [moveSpaceId, setMoveSpaceId] = useState('')
  const [moveFolderId, setMoveFolderId] = useState('')
  const [moveFolders, setMoveFolders] = useState<KnowledgeFolder[]>([])

  const [viewDoc, setViewDoc] = useState<KnowledgeDocDetail | null>(null)
  const [viewingId, setViewingId] = useState('')
  const [mode, setMode] = useState<'list' | 'graph'>('list')
  const [kbRefreshToken, setKbRefreshToken] = useState(0)
  const [sideOpen, setSideOpen] = useState(true)

  const activeScope: 'global' | 'workspace' = listScope

  // 知识空间 / 目录树加载
  const refreshSpaces = useCallback(async () => {
    try {
      const r = await fetchKnowledgeSpaces(activeScope)
      setSpaces(r.spaces)
      setDefaultSpaceId(r.defaultSpaceId ?? '')
      setCurrentSpaceId((prev) => (prev && r.spaces.some((s) => s.id === prev) ? prev : r.defaultSpaceId ?? r.spaces[0]?.id ?? ''))
    } catch {
      /* 空间加载失败不阻塞词条列表 */
    }
  }, [activeScope])

  const refreshFolders = useCallback(async () => {
    if (!currentSpaceId) {
      setFolders([])
      return
    }
    try {
      setFolders(await fetchKnowledgeFolders(currentSpaceId, activeScope))
    } catch {
      setFolders([])
    }
  }, [currentSpaceId, activeScope])

  // 搜索防抖：停敲 300ms 才发请求（连敲 5 字只产生 1 次请求）；
  // 序号丢弃：慢的旧响应回来后不覆盖新结果——乱序是搜索列表的老毛病。
  const dq = useDebouncedValue(q)
  const reqSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current
    setLoading(true)
    setLoadError('')
    try {
      const res = await fetchKnowledgeDocs({
        scope: activeScope,
        spaceId: currentSpaceId || undefined,
        folderId: currentFolderId || undefined,
        q: dq || undefined,
      })
      if (seq !== reqSeqRef.current) return
      setDocs(res.docs)
      setHasEmbedding(res.hasEmbedding)
    } catch (e) {
      if (seq !== reqSeqRef.current) return
      setDocs([])
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === reqSeqRef.current) {
        setLoading(false)
        setLoaded(true)
      }
    }
  }, [activeScope, currentSpaceId, currentFolderId, dq])

  useEffect(() => {
    void refreshSpaces()
  }, [refreshSpaces])
  useEffect(() => {
    void refreshFolders()
  }, [refreshFolders])
  useEffect(() => {
    void refresh()
  }, [refresh, kbRefreshToken])

  const switchSpace = (id: string) => {
    setCurrentSpaceId(id)
    setCurrentFolderId('')
    setQaAnswer('')
    setQaHits([])
    setQaError('')
  }

  const doCreateSpace = async () => {
    const name = newSpaceName.trim()
    if (!name) {
      onToast('请输入空间名称')
      return
    }
    try {
      const s = await createKnowledgeSpace(name, undefined, activeScope)
      setNewSpaceName('')
      await refreshSpaces()
      setCurrentSpaceId(s.id)
      setCurrentFolderId('')
      onToast(`已创建空间「${s.name}」`)
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doDeleteSpace = async (id: string) => {
    const s = spaces.find((x) => x.id === id)
    if (!s) return
    if (s.builtin) {
      onToast('默认空间不可删除')
      return
    }
    if (!confirm(`删除空间「${s.name}」将级联删除其全部文档，确定？`)) return
    try {
      const n = await deleteKnowledgeSpace(id, activeScope)
      onToast(`已删除空间，连带移除 ${n} 个文档`)
      await refreshSpaces()
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doCreateFolder = async (parentId?: string | null) => {
    const name = newFolderName.trim()
    if (!currentSpaceId) {
      onToast('请先选择知识空间')
      return
    }
    if (!name) {
      onToast('请输入目录名称')
      return
    }
    try {
      await createKnowledgeFolder(currentSpaceId, name, parentId ?? null, activeScope)
      setNewFolderName('')
      await refreshFolders()
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doDeleteFolder = async (id: string, name: string) => {
    if (!confirm(`删除目录「${name}」？其中文档将移到根目录，子目录上移。`)) return
    try {
      await deleteKnowledgeFolder(id, activeScope)
      if (currentFolderId === id) setCurrentFolderId('')
      await refreshFolders()
      void refresh()
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doDelete = async (id: string, title: string) => {
    if (!confirm(`确定删除词条「${title}」？此操作不可撤销。`)) return
    await deleteKnowledgeDoc(id)
    if (viewDoc?.id === id) setViewDoc(null)
    void refresh()
  }

  const loadMoveFolders = async (spaceId: string) => {
    try {
      setMoveFolders(await fetchKnowledgeFolders(spaceId, activeScope))
    } catch {
      setMoveFolders([])
    }
  }

  const startMove = (id: string) => {
    setMovingId(id)
    setMoveSpaceId(currentSpaceId)
    setMoveFolderId(currentFolderId)
    void loadMoveFolders(currentSpaceId)
  }

  const doMoveDoc = async (id: string) => {
    if (!moveSpaceId) {
      onToast('请选择目标知识空间')
      return
    }
    try {
      const ok = await moveKnowledgeDoc(id, moveSpaceId, moveFolderId || null, activeScope)
      onToast(ok ? '已移动文档' : '移动失败：文档不存在')
      setMovingId('')
      void refresh()
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  const doAsk = async () => {
    const question = qaQuestion.trim()
    if (!question) {
      setQaError('请输入要提问的内容')
      return
    }
    setQaLoading(true)
    setQaError('')
    try {
      const r = await askKnowledge({ q: question, scope: activeScope, spaceId: currentSpaceId || undefined, topK: 5 })
      setQaAnswer(r.answer)
      setQaHits(r.hits)
    } catch (e) {
      setQaError(e instanceof Error ? e.message : String(e))
      setQaAnswer('')
      setQaHits([])
    } finally {
      setQaLoading(false)
    }
  }

  const openDoc = async (id: string) => {
    setViewingId(id)
    try {
      setViewDoc(await fetchKnowledgeDoc(id))
    } catch (e) {
      setViewDoc(null)
      onToast(e instanceof Error ? e.message : String(e))
    } finally {
      setViewingId('')
    }
  }

  const doClear = async () => {
    if (!confirm('确定清空当前知识空间全部文档？此操作不可撤销。')) return
    const n = await clearKnowledge()
    onToast(`已清空 ${n} 个文档`)
    void refresh()
  }

  const doReindex = async () => {
    try {
      const r = await reindexKnowledge()
      onToast(`重建索引完成：全局 ${r.global.total}（已向量化 ${r.global.embedded}），工作区 ${r.workspace.total}（已向量化 ${r.workspace.embedded}）`)
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e))
    }
  }

  // 目录树辅助
  const folderChildren = (parentId: string | null) => folders.filter((f) => (f.parentId ?? null) === parentId)
  const renderFolderTree = (parentId: string | null, depth = 0) => (
    folderChildren(parentId).map((f) => (
      <div key={f.id}>
        <div className={`kb-folder-row${currentFolderId === f.id ? ' active' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}>
          <button className="btn-link kb-folder-name" title={f.name} onClick={() => setCurrentFolderId(f.id)}>
            <span className="kb-folder-ico">{f.name}</span>
          </button>
          <button className="btn-link danger" title="删除目录" aria-label="删除目录" onClick={() => void doDeleteFolder(f.id, f.name)}><Icon name="close" size={14} /></button>
        </div>
        {renderFolderTree(f.id, depth + 1)}
      </div>
    ))
  )
  const currentSpace = spaces.find((s) => s.id === currentSpaceId)
  const currentFolder = folders.find((f) => f.id === currentFolderId)

  return (
    <>
      <div className="kb-layout">
        <aside className={`kb-side${sideOpen ? ' open' : ''}`}>
          <button className="kb-side-handle" onClick={() => setSideOpen((o) => !o)} title={sideOpen ? '收起控制栏' : '展开控制栏'}>
            <span className="kb-side-arrow">{sideOpen ? <Icon name="chevron-left" /> : <Icon name="chevron-right" />}</span>
            <span className="kb-side-label">控制</span>
          </button>
          <div className="kb-side-body">
      <div className="section-hint">
        自生长知识库：上传文档后自动分块，配置 OpenAI 兼容 embeddings 则启用语义检索（RAG），未配置时降级关键词匹配。
        支持多知识库空间与目录树管理，命中内容会注入到每次对话的 systemPrompt（上限 8KB）。
      </div>

      <div className="sub-model-card mb-3">
        <div className="sub-model-head">
          <span className="sub-idx">知识库问答（带溯源）</span>
        </div>
        <p className="section-hint">针对当前空间提问，AI 将基于检索片段作答，并在句末标注 [1][2] 来源编号，可点击溯源到词条。</p>
        <div className="field-row">
          <input value={qaQuestion} placeholder="如 本项目施工规范中对材料进场有哪些要求？" onChange={(e) => setQaQuestion(e.target.value)} className="grow" onKeyDown={(e) => { if (isSubmitEnter(e)) void doAsk() }} />
          <button className="btn primary" onClick={() => void doAsk()} disabled={qaLoading}>
            {qaLoading ? '回答中…' : '提问'}
          </button>
        </div>
        {qaError && <InlineError>{qaError}</InlineError>}
        {qaAnswer && (
          <div className="kb-qa-answer">
            <div className="kb-doc-content"><Markdown text={qaAnswer} onPreview={() => {}} /></div>
            {qaHits.length > 0 && (
              <div className="kb-qa-sources">
                <div className="meta mt-2 mb-1">来源：</div>
                {qaHits.map((h, i) => (
                  <div key={h.chunkId} className="kb-qa-source">
                    <button className="btn-link" onClick={() => void openDoc(h.docId)}>[{i + 1}] {h.docTitle}</button>
                    <span className="meta"> · 相关度 {h.score.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="field-row mb-3">
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="标题/来源/标签关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field w-160">
          <span>作用域</span>
          <select value={listScope} onChange={(e) => setListScope(e.target.value as 'global' | 'workspace')}>
            <option value="global">global</option>
            <option value="workspace">workspace</option>
          </select>
        </label>
        <div className="row-end">
          <button className="btn" onClick={() => void doReindex()}>重建索引</button>
          {docs.length > 0 && (
            <button className="btn" onClick={() => void doClear()}>清空</button>
          )}
        </div>
      </div>

      <div className="section-hint">
        向量能力：{loaded ? (hasEmbedding ? '✓ 已配置 embedding（语义检索）' : '未配置 embedding（降级关键词匹配）') : '检测中…'}
      </div>
          </div>
        </aside>

        <div className="kb-main">
      <div className="kb-view-toggle" role="tablist">
        <button className={`kb-view-tab${mode === 'list' ? ' active' : ''}`} onClick={() => setMode('list')}>词条列表</button>
        <button className={`kb-view-tab${mode === 'graph' ? ' active' : ''}`} onClick={() => setMode('graph')}>信息链接图谱</button>
      </div>

      {mode === 'graph' ? (
        <Suspense fallback={null}>
          <KnowledgeGraph docs={docs} onToast={onToast} />
        </Suspense>
      ) : (
        <>
          <div className="settings-section kb-doc-list">
        {loading ? (
          <div className="empty-hint"><InlineLoading /></div>
        ) : docs.length === 0 ? (
          <div className="empty-hint">
            {loadError ? (
              <>
                <InlineError>加载失败：{loadError}</InlineError>{' '}
                <button className="btn" onClick={() => void refresh()}>重试</button>
              </>
            ) : loaded ? (
              '知识库为空。上传文档或安装专业化包以填充。'
            ) : (
              <InlineLoading />
            )}
          </div>
        ) : (
          docs.map((d) => {
            const expanded = viewDoc?.id === d.id
            return (
              <div key={d.id} className={`sub-model-card${expanded ? ' active' : ''}`}>
                <div className="sub-model-head">
                  <span className="sub-idx">
                    {d.source} · {d.title}
                    {d.specId ? ` [专业化:${d.specId}]` : ''} [{d.scope}] {d.chunkCount} 分块
                  </span>
                  <span className="sa-actions">
                    <button className="btn-link" onClick={() => (expanded ? setViewDoc(null) : void openDoc(d.id))} disabled={viewingId === d.id}>
                      {viewingId === d.id ? '查看中…' : expanded ? '收起' : '查看'}
                    </button>
                    {movingId === d.id ? (
                      <button className="btn-link" onClick={() => setMovingId('')}>取消</button>
                    ) : (
                      <button className="btn-link" onClick={() => startMove(d.id)}>移动</button>
                    )}
                    <button className="btn-link danger" onClick={() => void doDelete(d.id, d.title)}>删除</button>
                  </span>
                </div>
                <div className="meta">{d.contentLength} 字符 · {new Date(d.createdAt).toLocaleString()}</div>
                {expanded && (
                  <div className="kb-doc-detail">
                    {viewDoc.tags?.length ? (
                      <div className="cap-tags my-2">
                        {viewDoc.tags.map((t) => <span key={t} className="cap-tag">{t}</span>)}
                      </div>
                    ) : null}
                    <div className="kb-doc-content"><Markdown text={viewDoc.content} onPreview={() => {}} /></div>
                  </div>
                )}
                {movingId === d.id && (
                  <div className="kb-move-row">
                    <select value={moveSpaceId} onChange={(e) => { const v = e.target.value; setMoveSpaceId(v); setMoveFolderId(''); void loadMoveFolders(v) }}>
                      {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <select value={moveFolderId} onChange={(e) => setMoveFolderId(e.target.value)}>
                      <option value="">根目录</option>
                      {moveFolders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    <button className="btn primary" onClick={() => void doMoveDoc(d.id)}>确认移动</button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
          </>
        )
      }
        </div>
      </div>

      {settingsOpen && (
        <div className="modal-mask" onClick={closeSettings}>
          <div
            className="modal settings-modal"
            ref={settingsModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="知识库设置"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                closeSettings()
              }
            }}
          >
            <h3>知识库设置</h3>
            <div className="settings-body">
              <KnowledgeSettingsPanel config={config} onSave={onSave} />
              <div className="sub-model-card mb-3">
                <button className="trae-section-toggle" aria-expanded={uploadOpen} onClick={() => setUploadOpen((v) => !v)}>
                  <span className="trae-section-name">上传知识文档</span>
                  <span className="trae-caret">{uploadOpen ? '▾' : '▸'}</span>
                </button>
                {/* 展开才挂载：面板内的空间/目录请求只在用户真的要上传时发出 */}
                {uploadOpen && (
                  <KnowledgeUploadPanel onToast={onToast} onUploaded={() => setKbRefreshToken((t) => t + 1)} />
                )}
              </div>
              <div className="sub-model-card mb-3">
                <div className="sub-model-head">
                  <span className="sub-idx">知识空间与目录</span>
                </div>
                <div className="field-row">
                  <label className="field w-160">
                    <span>库作用域</span>
                    <select value={listScope} onChange={(e) => { setListScope(e.target.value as 'global' | 'workspace'); setCurrentFolderId('') }}>
                      <option value="global">global（全局）</option>
                      <option value="workspace">workspace（工作区）</option>
                    </select>
                  </label>
                  <label className="field grow">
                    <span>知识空间</span>
                    <select value={currentSpaceId} onChange={(e) => switchSpace(e.target.value)}>
                      {spaces.length === 0 && <option value="">加载中…</option>}
                      {spaces.map((s) => <option key={s.id} value={s.id}>{s.builtin ? '★ ' : ''}{s.name}{s.id === defaultSpaceId ? '（默认）' : ''}</option>)}
                    </select>
                  </label>
                  {!currentSpace?.builtin && currentSpace && (
                    <label className="field w-90">
                      <span>&nbsp;</span>
                      <button className="btn danger" onClick={() => void doDeleteSpace(currentSpace.id)}>删除空间</button>
                    </label>
                  )}
                </div>
                {currentSpace?.description && <div className="meta mt-1 mb-2">{currentSpace.description}</div>}
                <div className="field-row mb-2">
                  <input value={newSpaceName} placeholder="新空间名称，如 建筑工程规范" onChange={(e) => setNewSpaceName(e.target.value)} className="grow" />
                  <button className="btn" onClick={() => void doCreateSpace()}>新建空间</button>
                </div>
                <div className="kb-folders">
                  <div className={`kb-folder-row${currentFolderId === '' ? ' active' : ''}`}>
                    <button className="btn-link kb-folder-name" onClick={() => setCurrentFolderId('')}>全部文档</button>
                  </div>
                  {renderFolderTree(null)}
                  <div className="field-row mt-2">
                    <input value={newFolderName} placeholder="目录名" onChange={(e) => setNewFolderName(e.target.value)} className="grow" />
                    <button className="btn" onClick={() => void doCreateFolder(currentFolderId || null)}>新建目录</button>
                  </div>
                  <div className="meta">当前目录：{currentFolder ? currentFolder.name : '根目录（全部文档）'} · 共 {docs.length} 个词条</div>
                </div>
              </div>
            </div>
            <button className="btn" onClick={closeSettings}>关闭</button>
          </div>
        </div>
      )}
    </>
  )
}

/** 知识库独立页面：顶部返回 + 可滚动内容（配置 / 上传 / 词条列表 / 词条详情）。 */
function KnowledgePage({
  config,
  onSave,
  onToast,
  onBack,
}: {
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
  onToast: (message: string) => void
  onBack: () => void
}) {
  const [kbSettingsOpen, setKbSettingsOpen] = useState(false)
  return (
    <main className="main kb-page">
      <header className="topbar">
        <button className="btn-link" onClick={onBack}><Icon name="arrow-left" /> 返回对话</button>
        <span className="kb-page-title">知识库</span>
        <span className="kb-page-sub">自生长知识库</span>
        <button className="btn-link kb-settings-btn" title="知识库设置" aria-label="知识库设置" onClick={() => setKbSettingsOpen(true)}><Icon name="sliders" /></button>
      </header>
      <div className="kb-scroll kb-page-scroll">
        <KnowledgePanel onToast={onToast} config={config} onSave={onSave} settingsOpen={kbSettingsOpen} onCloseSettings={() => setKbSettingsOpen(false)} />
      </div>
    </main>
  )
}
