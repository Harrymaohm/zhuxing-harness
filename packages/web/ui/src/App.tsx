import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, archiveSession, askKnowledge, checkUpdate, clearKnowledge, createKnowledgeFolder, createKnowledgeSpace, createSpace, createTempWorkspace, deleteKnowledgeDoc, deleteKnowledgeFolder, deleteKnowledgeSpace, deleteSession, fetchConfig, fetchKnowledgeDoc, fetchKnowledgeDocs, fetchKnowledgeFolders, fetchKnowledgeSpaces, fetchSessions, fetchSpaces, fetchSpecs, fetchTokenPlanModels, forkSession, initAccessToken, installSpec, installUpdateZip, mergeSession, moveKnowledgeDoc, pickWorkspaceDir, reindexKnowledge, removeSpace, removeSpec, renameSession, setSpecEnabled, triggerUpdate, unarchiveSession, uploadDropFile, uploadKnowledge } from './api'
import { CAPABILITY_LABELS, CAPABILITY_OPTIONS } from './types'
import type { ChatMessage, ImageModelEntry, MemoryEntry, SessionItem, SpaceItem, SubModelEntry, TokenPlanEntry, TokenPlanImageEntry, TokenPlanSimpleEntry, TokenPlanTextEntry, TraceItem, WebConfig } from './types'
import type { KnowledgeDoc, KnowledgeDocDetail, KnowledgeFolder, KnowledgeHit, KnowledgeSpace, SpecRecord, UpdateCheckResult } from './api'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { PresentationViewer, type PresentationViewerHandle } from 'pptx-wasm/react'
import pptxWasmUrl from 'pptx-wasm/wasm?url'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

let msgId = 0
const nextId = () => `m${++msgId}`

/** token-plan 专用域名（阿里云百炼聚合 API）。 */
const TOKEN_PLAN_ORIGIN = 'https://token-plan.cn-beijing.maas.aliyuncs.com'

/** 生图模型建议项（下拉提示，仍可自由输入）。 */
const IMAGE_MODEL_PRESETS = [
  'qwen-image',
  'qwen-image-plus',
  'qwen-image-max',
  'qwen-image-2.0',
  'qwen-image-2.0-pro',
  'qwen-image-3.0',
  'qwen-image-3.0-pro',
  'wanx-v1',
  'dall-e-3',
  'gpt-image-1',
]

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

/**
 * 从会话事件重建前端消息列表（历史会话 / 子对话共用）。
 * 工具轮次折叠为带 trace 的 assistant 消息（与实时对话观感一致，不渲染空白骨架）；
 * 图片附件还原为 images；重建内容均为「已完成」，不设 running。
 */
function rebuildMessages(
  events: Array<{ type: string; payload: unknown }>,
  sessionId?: string,
): ChatMessage[] {
  const list: ChatMessage[] = []
  let pending: ChatMessage | null = null
  let toolStep = 0
  for (const evt of events) {
    const p = evt.payload as {
      content?: string
      name?: string
      result?: unknown
      toolCalls?: unknown
      attachments?: Array<{ type: string; dataUrl: string }>
    }
    if (evt.type === 'user') {
      pending = null
      const images = Array.isArray(p.attachments) ? p.attachments.filter((a) => a.dataUrl).map((a) => a.dataUrl) : []
      list.push({ id: nextId(), role: 'user', content: p.content ?? '', images: images.length > 0 ? images : undefined })
    } else if (evt.type === 'assistant') {
      const toolCalls = Array.isArray(p.toolCalls)
        ? (p.toolCalls as Array<{ id?: string; name?: string; arguments?: string }>)
        : []
      if (toolCalls.length > 0) {
        toolStep += 1
        pending = {
          id: nextId(),
          role: 'assistant',
          content: p.content ?? '',
          sessionId,
          trace: [
            { type: 'step', step: toolStep },
            ...toolCalls.map((tc) => ({ type: 'tool' as const, toolName: tc.name ?? '', toolArgs: tc.arguments ?? '' })),
          ],
        }
        list.push(pending)
      } else {
        pending = null
        list.push({ id: nextId(), role: 'assistant', content: p.content ?? '', sessionId })
      }
    } else if (evt.type === 'tool') {
      const name = String(p.name ?? '')
      const result = p.result ? summarize(p.result) : ''
      if (pending) {
        const trace = [...(pending.trace ?? [])]
        let matched = false
        for (let i = trace.length - 1; i >= 0; i--) {
          if (trace[i].type === 'tool' && trace[i].toolName === name && trace[i].toolResult === undefined) {
            trace[i] = { ...trace[i], toolResult: result }
            matched = true
            break
          }
        }
        if (!matched) trace.push({ type: 'tool', toolName: name, toolResult: result })
        pending.trace = trace
      }
    }
  }
  return list
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
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [subChat, setSubChat] = useState<{ sessionId: string; parentId: string } | null>(null)
  /** 拖入的文件链接（绝对路径）。 */
  const [fileLinks, setFileLinks] = useState<Array<{ path: string; name: string }>>([])
  /** 拖入的图片附件（data URL，随消息发送给多模态模型）。 */
  const [attachments, setAttachments] = useState<Array<{ type: 'image'; dataUrl: string }>>([])
  const [dragging, setDragging] = useState(false)
  const sessionIdRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
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
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, autoScroll])

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
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
  }

  async function openSession(id: string) {
    setPage('chat')
    setRunning(false)
    abortRef.current?.abort()
    const res = await apiFetch(`/api/sessions/${id}/events`)
    if (!res.ok) return
    const data = (await res.json()) as { events: Array<{ type: string; source: string; payload: unknown }> }
    const list = rebuildMessages(data.events, id)
    setMessages(list)
    sessionIdRef.current = id
    setError('')
  }

  async function renameCurrentSession(id: string) {
    const title = editingTitle.trim()
    if (!title) {
      setEditingSessionId(null)
      return
    }
    const ok = await renameSession(id, title)
    if (!ok) {
      setError('会话重命名失败')
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
        setMessages([])
        sessionIdRef.current = undefined
      }
      await refreshSessions()
      await refreshSpaces()
    } else showToast('删除失败')
  }

  function handleSelectSpace(spaceId: string) {
    setActiveSpaceId(spaceId)
    setShowArchived(false)
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
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
    setShowArchived((v) => !v)
    setMessages([])
    setError('')
    sessionIdRef.current = undefined
  }

  async function saveConfigPatch(patch: Partial<WebConfig>) {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      setConfig((prev) => ({ ...prev, ...patch }))
      setShowSettings(false)
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
        body: JSON.stringify({ message, sessionId: sessionIdRef.current, spaceId: activeSpaceId || undefined, attachments: sentAttachments, contextSessionId: refSessionId || undefined }),
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
            handleSseEvent(event, data, patchAssistant)
            event = ''
          }
        }
      }
      void refreshSessions()
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err))
        patchAssistant((m) => ({ ...m, running: false, content: m.content || '（发生错误）', error: true }))
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
        patchAssistant((m) => ({
          ...m,
          trace: [...(m.trace ?? []), { type: 'step', step: Number(data.step) }],
        }))
        break
      case 'tool':
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
      case 'token':
        patchAssistant((m) => ({ ...m, content: `${m.content ?? ''}${String(data.text ?? '')}` }))
        break
      case 'result':
        sessionIdRef.current = String(data.sessionId ?? '')
        patchAssistant((m) => ({
          ...m,
          running: false,
          steps: Number(data.steps ?? 0),
          finishedReason: String(data.finishedReason ?? ''),
          sessionId: String(data.sessionId ?? ''),
        }))
        break
      case 'error':
        patchAssistant((m) => ({ ...m, running: false, content: `${m.content ?? ''}\n[错误] ${String(data.message ?? '')}`, error: true }))
        break
    }
  }

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
      <svg className="bg-flow-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="bgLineGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" stopOpacity="0.18" />
            <stop offset="0.5" stopColor="#8b5cf6" stopOpacity="0.28" />
            <stop offset="1" stopColor="#22d3ee" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        <path d="M -4 22 C 26 12, 52 38, 100 26" />
        <path d="M -4 42 C 22 34, 60 60, 100 46" />
        <path d="M -4 64 C 30 52, 66 78, 100 64" />
        <path d="M -4 86 C 24 78, 58 98, 100 86" />
      </svg>
      {dragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-inner">
            <span className="drag-overlay-icon">📎</span>
            <span>松开鼠标：文件生成链接 · 图片作为附件</span>
          </div>
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">筑星 Harness</span>
        </div>
        <div className="space-bar">
          <button
            className={`space-chip ${activeSpaceId === '' && !showArchived ? 'active' : ''}`}
            onClick={() => handleSelectSpace('')}
            title="默认空间"
          >
            默认
          </button>
          {spaces.map((sp) => (
            <div key={sp.id} className="space-item">
              <button
                className={`space-chip ${activeSpaceId === sp.id && !showArchived ? 'active' : ''}`}
                onClick={() => handleSelectSpace(sp.id)}
                title={sp.title}
              >
                {sp.title}
              </button>
              <button
                className="space-chip-del"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDeleteSpace(sp.id)
                }}
                title="删除空间"
              >
                ×
              </button>
            </div>
          ))}
          <button className="space-chip add" onClick={() => void handleNewSpace()} title="新建空间">
            +
          </button>
        </div>
        <button className={`btn archived-toggle${showArchived ? ' active' : ''}`} onClick={toggleArchived}>
          🗂 已归档对话
        </button>
        <button className="btn new-chat" onClick={newChat}>
          + 新对话
        </button>
        <div className="session-list">
          {(() => {
            const childrenByParent = new Map<string, SessionItem[]>()
            for (const s of sessions) {
              if (s.parentId) {
                const arr = childrenByParent.get(s.parentId) ?? []
                arr.push(s)
                childrenByParent.set(s.parentId, arr)
              }
            }
            const topLevel = sessions.filter((s) => !s.parentId || !sessions.some((p) => p.id === s.parentId))
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
                    <div className="session-meta">
                      {s.eventCount} 事件 · {s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : ''}
                    </div>
                  </button>
                )}
                <div className="session-actions">
                  {s.archived ? (
                    <button className="sa-btn" onClick={() => void handleRestore(s.id)} title="恢复">↩</button>
                  ) : (
                    <button className="sa-btn" onClick={() => void handleArchive(s.id)} title="归档">📁</button>
                  )}
                  <button className="sa-btn danger" onClick={() => void handleDelete(s.id)} title="删除">🗑</button>
                </div>
              </div>
            )
            return topLevel.flatMap((s) => [
              renderItem(s, false),
              ...(childrenByParent.get(s.id) ?? []).map((c) => renderItem(c, true)),
            ])
          })()}
          {sessions.length === 0 && <div className="empty-hint">{showArchived ? '暂无归档对话' : '暂无会话'}</div>}
        </div>
        <button className="btn settings-btn" onClick={() => setPage('knowledge')}>
          📚 知识库
        </button>
        <button className="btn settings-btn" onClick={() => setShowSettings(true)}>
          ⚙ 设置
        </button>
      </aside>

      {page === 'knowledge' ? (
        <KnowledgePage config={config} onSave={saveConfigPatch} onToast={showToast} onBack={() => setPage('chat')} />
      ) : (
      <main className="main">
        <header className="topbar">
          <span>对话 · 工作 · 交付</span>
          {config.model && <span className="model-badge">{config.model}</span>}
        </header>

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
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
                <div className="setup-kicker">首次使用</div>
                <h2>先连接你的模型</h2>
                <p>配置 API Key 和模型后，即可开始对话、执行任务并获得交付结果。</p>
                <button className="btn primary setup-btn" onClick={() => setShowSettings(true)}>
                  打开设置
                </button>
              </div>
            )
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              onPreview={(path) => setPreviewPath(path)}
              onFork={sessionIdRef.current ? () => void handleFork(sessionIdRef.current!) : undefined}
            />
          ))}
          {error && <div className="error-banner">✗ {error}</div>}
          {!autoScroll && messages.length > 0 && (
            <button className="jump-latest" onClick={jumpToLatest}>
              ↓ 新消息
            </button>
          )}
          <div ref={bottomRef} />
        </div>

        <div className={`composer${dragging ? ' dragging' : ''}`}>
          <div className="composer-tools">
            <button className="btn attach-pick" title="选择文件（可多选）" onClick={() => fileInputRef.current?.click()}>
              📎 选择文件
            </button>
            <button className="btn attach-pick" title="选择整个文件夹导入" onClick={() => folderInputRef.current?.click()}>
              📂 选择文件夹
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => handleSelectFiles(e.target.files, false)}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              style={{ display: 'none' }}
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
          {(fileLinks.length > 0 || attachments.length > 0) && (
            <div className="attach-row">
              {fileLinks.map((f) => (
                <span key={f.path} className="attach-chip file" title={f.path}>
                  <a onClick={() => setPreviewPath(f.path)}>{f.name}</a>
                  <button className="chip-x" onClick={() => setFileLinks((prev) => prev.filter((x) => x.path !== f.path))}>
                    ×
                  </button>
                </span>
              ))}
              {attachments.map((_a, i) => (
                <span key={i} className="attach-chip image">
                  🖼 图片 {i + 1}
                  <button className="chip-x" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                    ×
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
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="输入任务描述，可拖入文件/图片；Enter 发送 / Shift+Enter 换行"
            rows={2}
            disabled={running}
          />
          {running ? (
            <button className="btn stop-btn" onClick={() => abortRef.current?.abort()}>
              ■ 停止
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
      </main>
      )}

      {showSettings && <SettingsModal config={config} onSave={saveConfigPatch} onToast={showToast} onClose={() => setShowSettings(false)} />}
      {previewPath && <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
      {subChat && (
        <SubChatWindow
          subChat={subChat}
          onClose={() => setSubChat(null)}
          onMerged={(parentId) => void handleMerged(parentId)}
          onPreview={(path) => setPreviewPath(path)}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function MessageBubble({ msg, onPreview, onFork }: { msg: ChatMessage; onPreview: (path: string) => void; onFork?: () => void }) {
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
          {msg.trace && msg.trace.length > 0 && <TraceBlock trace={msg.trace} running={msg.running === true} />}
          <AssistantContent msg={msg} onPreview={onPreview} />
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

/** 执行过程折叠区块：默认折叠，点击展开查看 step/tool 调用详情。 */
function TraceBlock({ trace, running }: { trace: TraceItem[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const toolCount = trace.filter((t) => t.type === 'tool').length
  const stepCount = trace.filter((t) => t.type === 'step').length

  return (
    <div className="trace-block">
      <button className="trace-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? '▾' : '▸'} 执行过程（{stepCount} 步 · {toolCount} 次工具调用）
        {running && <span className="trace-running"> · 进行中…</span>}
      </button>
      {expanded && (
        <div className="trace-detail">
          {trace.map((item, i) => {
            if (item.type === 'step') {
              return (
                <div key={i} className="trace-step">
                  ▶ 第 {item.step} 步：调用模型
                </div>
              )
            }
            return (
              <div key={i} className="trace-tool">
                <div className="tool-name">🔧 {item.toolName}</div>
                {item.toolArgs && <div className="tool-args">{item.toolArgs}</div>}
                {item.toolResult !== undefined && (
                  <div className={`tool-result ${item.toolResult.startsWith('错误') ? 'err' : ''}`}>{item.toolResult}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 助手内容：长结果默认折叠展示（最终输出折叠），点击展开完整内容。 */
function AssistantContent({ msg, onPreview }: { msg: ChatMessage; onPreview: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const content = msg.content ?? ''
  const long = content.length > 400
  const shown = long && !expanded ? `${content.slice(0, 300)}…` : content
  // 骨架屏仅在「实时生成中且无执行过程」时显示：纯文本阶段表示 AI 输入中；
  // 有工具调用时以折叠的执行过程行表达进行中，避免占位动画与折叠块冲突
  const isRunning = msg.running === true
  const hasTrace = (msg.trace?.length ?? 0) > 0
  return (
    <>
      {shown ? (
        <div className="assistant-content">{renderMarkdown(shown, onPreview)}</div>
      ) : isRunning && !hasTrace ? (
        <div className="assistant-skeleton" aria-label="正在生成回复">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {long && (
        <button className="fold-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起 ↑' : `展开 ↓（完整 ${content.length} 字符）`}
        </button>
      )}
    </>
  )
}

interface MarkdownTableData {
  headers: string[]
  rows: string[][]
}

function renderMarkdown(text: string, onPreview: (path: string) => void) {
  const lines = text.split(/\r?\n/)
  const blocks: JSX.Element[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1
      continue
    }
    const block = parseMarkdownTableBlock(lines.slice(i))
    if (block) {
      blocks.push(<MarkdownTable key={`table-${i}`} table={block.table} />)
      i += block.consumed
      continue
    }
    const fence = /^\s*```(\w+)?\s*$/.exec(lines[i])
    if (fence) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i += 1
      blocks.push(<pre key={`code-${i}`} data-language={fence[1] || undefined}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (heading) {
      const level = Math.min(6, heading[1].length)
      const Heading = `h${level}` as keyof JSX.IntrinsicElements
      blocks.push(<Heading key={`heading-${i}`}>{renderInlineMarkdown(heading[2], onPreview)}</Heading>)
      i += 1
      continue
    }
    if (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) {
      const ordered = /^\s*\d+[.)]\s+/.test(lines[i])
      const items: string[] = []
      while (i < lines.length) {
        const match = ordered ? /^\s*\d+[.)]\s+(.+)$/.exec(lines[i]) : /^\s*[-*+]\s+(.+)$/.exec(lines[i])
        if (!match) break
        items.push(match[1])
        i += 1
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={`list-${i}`}>{items.map((item, index) => <li key={index}>{renderInlineMarkdown(item, onPreview)}</li>)}</List>)
      continue
    }
    const paragraph: string[] = [lines[i]]
    i += 1
    while (i < lines.length && lines[i].trim() && !parseMarkdownTableBlock(lines.slice(i)) && !/^\s*```/.test(lines[i]) && !/^\s*#{1,6}\s+/.test(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push(<p key={`paragraph-${i}`}>{renderInlineMarkdown(paragraph.join('\n'), onPreview)}</p>)
  }
  return blocks
}

function renderInlineMarkdown(text: string, onPreview: (path: string) => void) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g)
  return parts.map((part, index) => {
    const file = /^`([^`]+\.(?:md|txt|json|ya?ml|ts|tsx|js|jsx|css|html|csv))`$/i.exec(part)
    if (file) return <button key={index} className="file-link" onClick={() => onPreview(file[1])}>{file[1]}</button>
    if (/^`[^`]+`$/.test(part)) return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*\*[^*]+\*\*$/.test(part) || /^__[^_]+__$/.test(part)) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) return <em key={index}>{part.slice(1, -1)}</em>
    return <span key={index}>{part.split('\n').map((line, lineIndex) => <span key={lineIndex}>{line}{lineIndex < part.split('\n').length - 1 && <br />}</span>)}</span>
  })
}

function parseMarkdownTableBlock(lines: string[]): { table: MarkdownTableData; consumed: number } | null {
  if (lines.length < 2 || !/^\s*\|.*\|\s*$/.test(lines[0]) || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1])) {
    return null
  }
  const split = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
  const headers = split(lines[0])
  const rows: string[][] = []
  let consumed = 2
  while (consumed < lines.length && /^\s*\|.*\|\s*$/.test(lines[consumed])) {
    rows.push(split(lines[consumed]))
    consumed += 1
  }
  return { table: { headers, rows }, consumed }
}

function MarkdownTable({ table }: { table: MarkdownTableData }) {
  return (
    <div className="markdown-table-wrap">
      <table className="markdown-table">
        <thead><tr>{table.headers.map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, i) => <tr key={i}>{table.headers.map((_, j) => <td key={j}>{row[j] ?? ''}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** 清除上传文件可能携带的脚本/事件属性，本地工具仍按不可信输入处理。 */
function sanitizeOfficeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,base').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
      else if (name === 'data-v' || name === 'data-t' || name === 'id') el.removeAttribute(attr.name)
    }
  })
  return doc.body.innerHTML
}

function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [officeSheets, setOfficeSheets] = useState<Array<{ name: string; html: string }>>([])
  const [pptxFile, setPptxFile] = useState<Blob | null>(null)
  const [pptxCount, setPptxCount] = useState(0)
  const [pptxIndex, setPptxIndex] = useState(0)
  const pptxRef = useRef<PresentationViewerHandle | null>(null)
  const isPdf = /\.pdf$/i.test(path)
  const isDocx = /\.docx$/i.test(path)
  const isXlsx = /\.(xlsx|xls)$/i.test(path)
  const isPptx = /\.pptx$/i.test(path)
  const isBinary = isPdf || isDocx || isXlsx || isPptx
  const isText = !isBinary

  useEffect(() => {
    let cancelled = false
    setContent('')
    setError('')
    setPdfUrl(null)
    setOfficeSheets([])
    setPptxFile(null)
    setPptxCount(0)
    setPptxIndex(0)
    if (isText) {
      void apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}`)
        .then(async (res) => {
          const data = (await res.json()) as { content?: string; error?: string }
          if (!res.ok) throw new Error(data.error ?? `预览失败（HTTP ${res.status}）`)
          if (!cancelled) setContent(data.content ?? '')
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
      return () => { cancelled = true }
    }
    // 二进制格式：先经 raw=1 获取原始字节，再按扩展名在浏览器端渲染
    void apiFetch(`/api/files/preview?path=${encodeURIComponent(path)}&raw=1`)
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `预览失败（HTTP ${res.status}）`)
        }
        const blob = await res.blob()
        if (cancelled) return
        if (isPdf) {
          setPdfUrl(URL.createObjectURL(blob))
          return
        }
        if (isPptx) {
          setPptxFile(blob)
          return
        }
        const arrayBuffer = await blob.arrayBuffer()
        if (isDocx) {
          // mammoth 浏览器端 .docx → 安全的 HTML
          const result = await mammoth.convertToHtml({ arrayBuffer })
          if (!cancelled) setOfficeSheets([{ name: '', html: sanitizeOfficeHtml(result.value) }])
          return
        }
        if (isXlsx) {
          // SheetJS 读取 .xlsx/.xls → 逐工作表转 HTML 表格
          const wb = XLSX.read(arrayBuffer, { type: 'array' })
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name]
            const table = (XLSX.utils.sheet_to_html(ws).match(/<table[\s\S]*<\/table>/i)?.[0]) ?? ''
            return { name, html: sanitizeOfficeHtml(table) }
          })
          if (!cancelled) setOfficeSheets(sheets)
          return
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [path, isPdf, isDocx, isXlsx, isPptx, isText])

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    }
  }, [pdfUrl])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal file-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-preview-head"><strong>{path}</strong><button className="btn-link" onClick={onClose}>关闭</button></div>
        {error ? (
          <div className="error-banner">✗ {error}</div>
        ) : isPdf && pdfUrl ? (
          <iframe title="PDF 预览" src={pdfUrl} className="pdf-frame" />
        ) : isPptx && pptxFile ? (
          <div className="office-frame">
            <div className="ppt-toolbar">
              <button className="btn-link ppt-nav" disabled={pptxIndex <= 0} onClick={() => pptxRef.current?.previous()} title="上一页">‹ 上一页</button>
              <span className="ppt-counter">{pptxCount > 0 ? `第 ${pptxIndex + 1} / ${pptxCount} 页` : '加载中…'}</span>
              <button className="btn-link ppt-nav" disabled={pptxCount <= 0 || pptxIndex >= pptxCount - 1} onClick={() => pptxRef.current?.next()} title="下一页">下一页 ›</button>
            </div>
            <div className="ppt-stage">
              <PresentationViewer ref={pptxRef} src={pptxFile} wasm={pptxWasmUrl} width="100%" height="100%" onLoad={(info) => setPptxCount(info.slideCount)} onSlideChange={(i) => setPptxIndex(i)} />
            </div>
          </div>
        ) : officeSheets.length ? (
          <div className="file-preview-office">
            {officeSheets.map((sheet, i) => (
              <section key={i} className="office-sheet">
                {sheet.name ? <h4 className="office-sheet-title">{escapeHtml(sheet.name)}</h4> : null}
                <div className="office-sheet-body" dangerouslySetInnerHTML={{ __html: sheet.html }} />
              </section>
            ))}
          </div>
        ) : isText ? (
          <pre className="file-preview-content">{content || '加载中…'}</pre>
        ) : (
          <div className="file-preview-content">加载中…</div>
        )}
      </div>
    </div>
  )
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
  onPreview: (path: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [merging, setMerging] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadEvents = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/events`)
    if (!res.ok) return
    const data = (await res.json()) as { events: Array<{ type: string; payload: unknown }> }
    setMessages(rebuildMessages(data.events))
  }, [])

  useEffect(() => {
    void loadEvents(subChat.sessionId)
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
        body: JSON.stringify({ message, sessionId: subChat.sessionId }),
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
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        patchAssistant((m) => ({ ...m, running: false, content: m.content || '（发生错误）', error: true }))
      }
    } finally {
      setRunning(false)
      abortRef.current = null
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
          <MessageBubble key={m.id} msg={m} onPreview={onPreview} />
        ))}
        {messages.length === 0 && <div className="empty-hint">子对话已继承主对话历史，可在此独立探索。</div>}
      </div>
      <div className="subchat-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="子对话输入，Enter 发送 / Shift+Enter 换行"
          rows={2}
          disabled={running}
        />
        {running ? (
          <button className="btn stop-btn" onClick={() => abortRef.current?.abort()}>■ 停止</button>
        ) : (
          <button className="btn send-btn" onClick={() => void send()} disabled={!input.trim()}>发送</button>
        )}
      </div>
    </div>
  )
}

function SettingsModal({
  config,
  onSave,
  onToast,
  onClose,
}: {
  config: WebConfig
  onSave: (patch: Partial<WebConfig>) => void
  onToast: (message: string) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<WebConfig>({
    ...config,
    models: (config.models ?? []).map((m) => ({ ...m })),
    imageModel: config.imageModel ? { ...config.imageModel } : undefined,
    tokenPlan: config.tokenPlan
      ? {
          ...config.tokenPlan,
          textModels: (config.tokenPlan.textModels ?? []).map((m) => ({ ...m })),
          imageModels: (config.tokenPlan.imageModels ?? []).map((m) => ({ ...m })),
          videoModels: (config.tokenPlan.videoModels ?? []).map((m) => ({ ...m })),
          voiceModels: (config.tokenPlan.voiceModels ?? []).map((m) => ({ ...m })),
          realtimeModels: (config.tokenPlan.realtimeModels ?? []).map((m) => ({ ...m })),
        }
      : undefined,
  })
  const [tab, setTab] = useState<'main' | 'sub' | 'image' | 'token-plan' | 'env' | 'memory' | 'skills' | 'tools' | 'specs' | 'update'>('main')

  const setField = (key: keyof WebConfig, value: string) => setForm({ ...form, [key]: value })

  const useTempWorkspace = async () => {
    const dir = await createTempWorkspace()
    if (!dir) {
      onToast('创建临时工作区失败')
      return
    }
    setField('workspace', dir)
    onToast('已生成临时工作区')
  }

  const pickWorkspace = async () => {
    const dir = await pickWorkspaceDir()
    if (dir === null) return // 用户取消或失败
    setField('workspace', dir)
    onToast('已选择工作区')
  }

  const subModels = form.models ?? []
  const patchSub = (idx: number, patch: Partial<SubModelEntry>) => {
    const copy = [...subModels]
    copy[idx] = { ...copy[idx], ...patch }
    setForm({ ...form, models: copy })
  }
  const addSub = () => setForm({ ...form, models: [...subModels, { id: '', model: '', capabilities: ['general'] }] })
  const removeSub = (idx: number) => setForm({ ...form, models: subModels.filter((_, i) => i !== idx) })

  const img = form.imageModel
  const patchImg = (patch: Partial<ImageModelEntry>) => setForm({ ...form, imageModel: { model: '', ...(img ?? {}), ...patch } })

  // ===== token-plan 表单辅助 =====
  const tokenPlan = form.tokenPlan
  const patchTokenPlan = (patch: Partial<TokenPlanEntry>) => setForm({ ...form, tokenPlan: { ...(tokenPlan ?? {}), ...patch } })
  const tpText = tokenPlan?.textModels ?? []
  const tpImage = tokenPlan?.imageModels ?? []
  const tpVideo = tokenPlan?.videoModels ?? []
  const tpVoice = tokenPlan?.voiceModels ?? []
  const tpRealtime = tokenPlan?.realtimeModels ?? []
  const patchTpText = (idx: number, patch: Partial<TokenPlanTextEntry>) => {
    const copy = [...tpText]
    copy[idx] = { ...copy[idx], ...patch }
    patchTokenPlan({ textModels: copy })
  }
  const addTpText = () => patchTokenPlan({ textModels: [...tpText, { id: '', model: '', capabilities: ['general'] }] })
  const removeTpText = (idx: number) => patchTokenPlan({ textModels: tpText.filter((_, i) => i !== idx) })
  const patchTpImage = (idx: number, patch: Partial<TokenPlanImageEntry>) => {
    const copy = [...tpImage]
    copy[idx] = { ...copy[idx], ...patch }
    patchTokenPlan({ imageModels: copy })
  }
  const addTpImage = () => patchTokenPlan({ imageModels: [...tpImage, { model: '' }] })
  const removeTpImage = (idx: number) => patchTokenPlan({ imageModels: tpImage.filter((_, i) => i !== idx) })
  // 视频 / 语音 / Realtime 均为简单的 model+label 条目，复用同一套增删改逻辑
  type TpSimpleKind = 'videoModels' | 'voiceModels' | 'realtimeModels'
  const tpSimpleList = (kind: TpSimpleKind) =>
    kind === 'videoModels' ? tpVideo : kind === 'voiceModels' ? tpVoice : tpRealtime
  const patchTpSimple = (kind: TpSimpleKind, idx: number, patch: Partial<TokenPlanSimpleEntry>) => {
    const list = [...tpSimpleList(kind)]
    list[idx] = { ...list[idx], ...patch }
    patchTokenPlan({ [kind]: list } as Partial<TokenPlanEntry>)
  }
  const addTpSimple = (kind: TpSimpleKind) => {
    patchTokenPlan({ [kind]: [...tpSimpleList(kind), { model: '' }] } as Partial<TokenPlanEntry>)
  }
  const removeTpSimple = (kind: TpSimpleKind, idx: number) => {
    patchTokenPlan({ [kind]: tpSimpleList(kind).filter((_, i) => i !== idx) } as Partial<TokenPlanEntry>)
  }

  // ===== 从上游读取 token-plan 模型并自动填入 =====
  const [tpLoading, setTpLoading] = useState(false)
  const [tpError, setTpError] = useState('')
  async function loadTokenPlanModels() {
    if (!tokenPlan?.apiKey) {
      setTpError('请先填写 token-plan API Key')
      return
    }
    setTpLoading(true)
    setTpError('')
    try {
      const res = await fetchTokenPlanModels()
      const patch: Partial<TokenPlanEntry> = {}
      // 文本子模型：以 model 同时作为 id 唯一标识，能力标签按上游/推断补齐
      if (res.textModels.length) {
        patch.textModels = res.textModels.map((m) => ({
          id: m.model,
          model: m.model,
          label: m.label ?? m.model,
          capabilities: m.capabilities?.length ? m.capabilities : ['general'],
        }))
      }
      // 多模态清单：直接回填对应分类
      const img = res.builtin
      patch.imageModels = img.imageModels.map((m) => ({ model: m.model }))
      patch.videoModels = img.videoModels.slice()
      patch.voiceModels = img.voiceModels.slice()
      patch.realtimeModels = img.realtimeModels.slice()
      patchTokenPlan(patch)
      setTpError(res.error ? `上游读取失败，已回退内置清单：${res.error}` : '')
    } catch (e) {
      setTpError(e instanceof Error ? e.message : String(e))
    } finally {
      setTpLoading(false)
    }
  }

  function save() {
    // 过滤无效子模型条目（id 或 model 为空）
    const models = subModels.filter((m) => m.id.trim() && m.model.trim())
    const imageModel = img && img.model.trim() ? img : undefined
    const patch: Partial<WebConfig> = { ...form, models, imageModel }
    // 服务端返回的是脱敏值（含 ***）：未修改的密钥字段不提交，避免掩码覆盖真实 Key
    const isMasked = (v?: string) => !!v && v.includes('***')
    if (isMasked(patch.apiKey)) delete patch.apiKey
    patch.models = models.map((m) => (isMasked(m.apiKey) ? { ...m, apiKey: undefined } : m))
    if (patch.imageModel && isMasked(patch.imageModel.apiKey)) {
      patch.imageModel = { ...patch.imageModel, apiKey: undefined }
    }
    // token-plan：过滤空条目、脱敏 apiKey
    if (patch.tokenPlan) {
      const tp = patch.tokenPlan
      const textModels = (tp.textModels ?? []).filter((m) => m.id.trim() && m.model.trim())
      const imageModels = (tp.imageModels ?? []).filter((m) => m.model.trim())
      const videoModels = (tp.videoModels ?? []).filter((m) => m.model.trim())
      const voiceModels = (tp.voiceModels ?? []).filter((m) => m.model.trim())
      const realtimeModels = (tp.realtimeModels ?? []).filter((m) => m.model.trim())
      const clean: Partial<TokenPlanEntry> = { ...tp, textModels, imageModels, videoModels, voiceModels, realtimeModels }
      if (isMasked(clean.apiKey)) clean.apiKey = undefined
      patch.tokenPlan = clean
    }
    onSave(patch)
  }

  const tabs = [
    { key: 'main' as const, label: '主模型' },
    { key: 'sub' as const, label: `子模型（${subModels.length}）` },
    { key: 'image' as const, label: '生图模型' },
    { key: 'token-plan' as const, label: 'token-plan' },
    { key: 'specs' as const, label: '专业化' },
    { key: 'memory' as const, label: '记忆' },
    { key: 'skills' as const, label: '技能' },
    { key: 'tools' as const, label: '工具' },
    { key: 'env' as const, label: '运行环境' },
    { key: 'update' as const, label: '更新' },
  ]

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <div className="settings-tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'main' && (
          <div className="settings-section">
            <p className="section-hint">主编排模型：负责理解任务、调用工具，并可动态委派子模型。</p>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey ?? ''}
                placeholder="sk-…"
                onChange={(e) => setField('apiKey', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Base URL（OpenAI 兼容端点）</span>
              <input
                value={form.baseUrl ?? ''}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setField('baseUrl', e.target.value)}
              />
            </label>
            <label className="field">
              <span>模型名</span>
              <input
                value={form.model ?? ''}
                placeholder="deepseek-v4-flash"
                onChange={(e) => setField('model', e.target.value)}
              />
            </label>
            <label className="field checkbox-field">
              <span>多模态（支持图片输入）</span>
              <input
                type="checkbox"
                checked={!!form.multimodal}
                onChange={(e) => setForm({ ...form, multimodal: e.target.checked })}
              />
            </label>
          </div>
        )}

        {tab === 'sub' && (
          <div className="settings-section">
            <p className="section-hint">
              子模型由主编排模型按任务需求自动选择（能力匹配 + 上下文 + 实时性能），也可在对话中指定。
            </p>
            {subModels.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeSub(idx)}>
                    删除
                  </button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>模型 ID（唯一标识）</span>
                    <input value={m.id} placeholder="coder" onChange={(e) => patchSub(idx, { id: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>模型名</span>
                    <input
                      value={m.model}
                      placeholder="deepseek-coder"
                      onChange={(e) => patchSub(idx, { model: e.target.value })}
                    />
                  </label>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>显示名称（可选）</span>
                    <input value={m.label ?? ''} placeholder="代码专家" onChange={(e) => patchSub(idx, { label: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>上下文窗口（token，可选）</span>
                    <input
                      type="number"
                      value={m.contextWindow ?? ''}
                      placeholder="64000"
                      onChange={(e) => patchSub(idx, { contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>能力标签（影响自动选择）</span>
                  <div className="cap-tags">
                    {CAPABILITY_OPTIONS.map((cap) => {
                      const active = (m.capabilities ?? []).includes(cap)
                      return (
                        <button
                          key={cap}
                          className={`cap-tag ${active ? 'active' : ''}`}
                          onClick={() => {
                            const caps = m.capabilities ?? []
                            patchSub(idx, { capabilities: active ? caps.filter((c) => c !== cap) : [...caps, cap] })
                          }}
                        >
                          {CAPABILITY_LABELS[cap] ?? cap}
                        </button>
                      )
                    })}
                  </div>
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Base URL（可选，缺省用主端点）</span>
                    <input value={m.baseUrl ?? ''} placeholder="留空 = 主端点" onChange={(e) => patchSub(idx, { baseUrl: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>API Key（可选，缺省用主 Key）</span>
                    <input
                      type="password"
                      value={m.apiKey ?? ''}
                      placeholder="留空 = 主 Key"
                      onChange={(e) => patchSub(idx, { apiKey: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={addSub}>
              + 添加子模型
            </button>
          </div>
        )}

        {tab === 'image' && (
          <div className="settings-section">
            <p className="section-hint">配置后 Agent 获得 generate_image 工具，可按描述生成图片。阿里云百炼 qwen-image 系列请选择 DashScope 原生模式。</p>
            <label className="field">
              <span>协议模式</span>
              <select value={img?.mode ?? 'openai'} onChange={(e) => patchImg({ mode: (e.target.value as 'openai' | 'dashscope') })}>
                <option value="openai">OpenAI 兼容（images 端点，dall-e-3 / wanx 等）</option>
                <option value="dashscope">DashScope 原生（阿里云百炼 qwen-image 系列）</option>
              </select>
            </label>
            <label className="field">
              <span>生图模型名</span>
              <input
                list="image-model-presets"
                value={img?.model ?? ''}
                placeholder="wanx-v1 / dall-e-3（留空 = 未启用）"
                onChange={(e) => patchImg({ model: e.target.value })}
              />
              <datalist id="image-model-presets">
                {IMAGE_MODEL_PRESETS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>Base URL（可选，缺省用主端点）</span>
              <input value={img?.baseUrl ?? ''} placeholder={img?.mode === 'dashscope' ? 'https://dashscope.aliyuncs.com' : 'https://api.deepseek.com/v1'} onChange={(e) => patchImg({ baseUrl: e.target.value })} />
            </label>
            <label className="field">
              <span>API Key（可选，缺省用主 Key）</span>
              <input type="password" value={img?.apiKey ?? ''} placeholder="留空 = 主 Key" onChange={(e) => patchImg({ apiKey: e.target.value })} />
            </label>
            <label className="field">
              <span>默认尺寸</span>
              <input value={img?.size ?? ''} placeholder={img?.mode === 'dashscope' ? '1328*1328' : '1024x1024'} onChange={(e) => patchImg({ size: e.target.value })} />
            </label>
          </div>
        )}

        {tab === 'token-plan' && (
          <div className="settings-section">
            <p className="section-hint">
              token-plan 是阿里云百炼的聚合 API：一个 Key 下挂多个模型（文本生成 / 生图 / 视频 / 语音 / Realtime-Chatting），单独配置。
              其中文本子模型会注册进模型路由，由主模型通过 pick_model 自行判断调用；生图 / 视频 / 语音分别启用 generate_image / generate_video / text_to_speech（均为 DashScope 原生协议）。
            </p>
            <label className="field">
              <span>API Key（token-plan 专用）</span>
              <input
                type="password"
                value={tokenPlan?.apiKey ?? ''}
                placeholder="sk-…"
                onChange={(e) => patchTokenPlan({ apiKey: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Base URL（专用域名）</span>
              <input
                value={tokenPlan?.baseUrl ?? ''}
                placeholder={TOKEN_PLAN_ORIGIN}
                onChange={(e) => patchTokenPlan({ baseUrl: e.target.value })}
              />
            </label>

            <div className="tp-fetch-row">
              <button className="btn" onClick={loadTokenPlanModels} disabled={tpLoading}>
                {tpLoading ? '读取中…' : '从上游读取模型'}
              </button>
              <span className="section-hint">文本模型走 OpenAI 兼容 /models 实时读取，生图/视频/语音/Realtime 按官方清单回填。</span>
            </div>
            {tpError && <p className="tp-error">{tpError}</p>}

            <h4 className="sub-heading">文本生成子模型（由主模型选调）</h4>
            {tpText.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpText(idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>模型 ID（唯一标识）</span>
                    <input value={m.id} placeholder="tp-code" onChange={(e) => patchTpText(idx, { id: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>模型名</span>
                    <input value={m.model} placeholder="qwen-max" onChange={(e) => patchTpText(idx, { model: e.target.value })} />
                  </label>
                </div>
                <label className="field">
                  <span>显示名称（可选）</span>
                  <input value={m.label ?? ''} placeholder="通义千问" onChange={(e) => patchTpText(idx, { label: e.target.value })} />
                </label>
                <label className="field">
                  <span>能力标签（影响自动选择）</span>
                  <div className="cap-tags">
                    {CAPABILITY_OPTIONS.map((cap) => {
                      const active = (m.capabilities ?? []).includes(cap)
                      return (
                        <button
                          key={cap}
                          className={`cap-tag ${active ? 'active' : ''}`}
                          onClick={() => {
                            const caps = m.capabilities ?? []
                            patchTpText(idx, { capabilities: active ? caps.filter((c) => c !== cap) : [...caps, cap] })
                          }}
                        >
                          {CAPABILITY_LABELS[cap] ?? cap}
                        </button>
                      )
                    })}
                  </div>
                </label>
              </div>
            ))}
            <button className="btn add-sub" onClick={addTpText}>+ 添加文本子模型</button>

            <h4 className="sub-heading">生图模型（首个用于 generate_image）</h4>
            {tpImage.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpImage(idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>生图模型名</span>
                    <input value={m.model} placeholder="qwen-image / wan2.7-image" onChange={(e) => patchTpImage(idx, { model: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>默认尺寸</span>
                    <input value={m.size ?? ''} placeholder="1328*1328" onChange={(e) => patchTpImage(idx, { size: e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={addTpImage}>+ 添加生图模型</button>

            <h4 className="sub-heading">视频生成模型（首个用于 generate_video）</h4>
            {tpVideo.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpSimple('videoModels', idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>视频模型名</span>
                    <input value={m.model} placeholder="wan2.7-t2v / happyhorse-1.1-t2v" onChange={(e) => patchTpSimple('videoModels', idx, { model: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>显示名称（可选）</span>
                    <input value={m.label ?? ''} placeholder="视频生成" onChange={(e) => patchTpSimple('videoModels', idx, { label: e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={() => addTpSimple('videoModels')}>+ 添加视频生成模型</button>

            <h4 className="sub-heading">语音模型（首个用于 text_to_speech）</h4>
            {tpVoice.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpSimple('voiceModels', idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>语音模型名</span>
                    <input value={m.model} placeholder="qwen-tts" onChange={(e) => patchTpSimple('voiceModels', idx, { model: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>显示名称（可选）</span>
                    <input value={m.label ?? ''} placeholder="语音合成" onChange={(e) => patchTpSimple('voiceModels', idx, { label: e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={() => addTpSimple('voiceModels')}>+ 添加语音模型</button>

            <h4 className="sub-heading">Realtime-Chatting 模型（配置占位）</h4>
            {tpRealtime.map((m, idx) => (
              <div key={idx} className="sub-model-card">
                <div className="sub-model-head">
                  <span className="sub-idx">#{idx + 1}</span>
                  <button className="btn-link danger" onClick={() => removeTpSimple('realtimeModels', idx)}>删除</button>
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Realtime 模型名</span>
                    <input value={m.model} placeholder="qwen-realtime" onChange={(e) => patchTpSimple('realtimeModels', idx, { model: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>显示名称（可选）</span>
                    <input value={m.label ?? ''} placeholder="实时对话" onChange={(e) => patchTpSimple('realtimeModels', idx, { label: e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
            <button className="btn add-sub" onClick={() => addTpSimple('realtimeModels')}>+ 添加 Realtime 模型</button>
          </div>
        )}

        {tab === 'env' && (
          <div className="settings-section">
            <label className="field">
              <span>工作区（Agent 文件/命令操作的根目录）</span>
              <input value={form.workspace ?? ''} placeholder="绝对路径" onChange={(e) => setField('workspace', e.target.value)} />
            </label>
            <div className="ws-picker">
              <button className="btn" onClick={() => void pickWorkspace()}>📁 选择目录</button>
              <button className="btn" onClick={() => void useTempWorkspace()}>✨ 临时工作区</button>
            </div>
            <label className="field">
              <span>沙箱级别</span>
              <select value={form.level ?? 'danger-full-access'} onChange={(e) => setField('level', e.target.value)}>
                <option value="danger-full-access">danger-full-access（完全权限，默认）</option>
                <option value="workspace-write">workspace-write（工作区内可写）</option>
                <option value="read-only">read-only（只读）</option>
              </select>
            </label>
          </div>
        )}

        {tab === 'specs' && <SpecPanel onToast={onToast} />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'skills' && <SkillPanel />}
        {tab === 'tools' && <ToolPanel />}
        {tab === 'update' && <UpdatePanel />}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
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
    <div className="sub-model-card" style={{ marginBottom: 12 }}>
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

/** 上传知识文档面板（置于知识库设置弹层内，自带空间/目录选择，入库后通知外部刷新列表）。 */
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
    <div className="sub-model-card" style={{ marginBottom: 12 }}>
      <div className="sub-model-head">
        <span className="sub-idx">上传知识文档</span>
      </div>
      <div className="meta" style={{ marginBottom: 8 }}>
        归档到：空间「{currentSpace?.name ?? '默认'}」 / 目录「{currentFolder ? currentFolder.name : '根目录'}」
      </div>
      <div className="field-row">
        <label className="field" style={{ flex: 1 }}>
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
        <label className="field" style={{ flex: 1 }}>
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
      {files.length > 0 && <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>已选：{files.map((f) => f.name).join('、')}</div>}
      <button className="btn primary" onClick={() => void doUpload()} disabled={uploading}>
        {uploading ? '入库中…' : '上传入库'}
      </button>
      {error && <div className="meta" style={{ color: '#ff6b6b', marginTop: 8 }}>{error}</div>}
    </div>
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

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await fetchKnowledgeDocs({
        scope: activeScope,
        spaceId: currentSpaceId || undefined,
        folderId: currentFolderId || undefined,
        q: q || undefined,
      })
      setDocs(res.docs)
      setHasEmbedding(res.hasEmbedding)
    } catch (e) {
      setDocs([])
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [activeScope, currentSpaceId, currentFolderId, q])

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

  const doDelete = async (id: string) => {
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
          <button className="btn-link danger" title="删除目录" onClick={() => void doDeleteFolder(f.id, f.name)}>×</button>
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
            <span className="kb-side-arrow">{sideOpen ? '‹' : '›'}</span>
            <span className="kb-side-label">控制</span>
          </button>
          <div className="kb-side-body">
      <div className="section-hint">
        自生长知识库：上传文档后自动分块，配置 OpenAI 兼容 embeddings 则启用语义检索（RAG），未配置时降级关键词匹配。
        支持多知识库空间与目录树管理，命中内容会注入到每次对话的 systemPrompt（上限 8KB）。
      </div>

      <div className="sub-model-card" style={{ marginBottom: 12 }}>
        <div className="sub-model-head">
          <span className="sub-idx">知识库问答（带溯源）</span>
        </div>
        <p className="section-hint">针对当前空间提问，AI 将基于检索片段作答，并在句末标注 [1][2] 来源编号，可点击溯源到词条。</p>
        <div className="field-row">
          <input value={qaQuestion} placeholder="如 本项目施工规范中对材料进场有哪些要求？" onChange={(e) => setQaQuestion(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === 'Enter') void doAsk() }} />
          <button className="btn primary" onClick={() => void doAsk()} disabled={qaLoading}>
            {qaLoading ? '回答中…' : '提问'}
          </button>
        </div>
        {qaError && <div className="meta" style={{ color: '#ff6b6b', marginTop: 8 }}>{qaError}</div>}
        {qaAnswer && (
          <div className="kb-qa-answer">
            <div className="kb-doc-content">{renderMarkdown(qaAnswer, () => {})}</div>
            {qaHits.length > 0 && (
              <div className="kb-qa-sources">
                <div className="meta" style={{ margin: '8px 0 4px' }}>来源：</div>
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

      <div className="field-row" style={{ marginBottom: 12 }}>
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="标题/来源/标签关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field" style={{ maxWidth: 160 }}>
          <span>作用域</span>
          <select value={listScope} onChange={(e) => setListScope(e.target.value as 'global' | 'workspace')}>
            <option value="global">global</option>
            <option value="workspace">workspace</option>
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
        <KnowledgeGraph docs={docs} onToast={onToast} />
      ) : (
        <>
          <div className="settings-section kb-doc-list">
        {loading ? (
          <div className="empty-hint">加载中…</div>
        ) : docs.length === 0 ? (
          <div className="empty-hint">
            {loadError ? (
              <>
                <span style={{ color: '#ff6b6b' }}>加载失败：{loadError}</span>{' '}
                <button className="btn" onClick={() => void refresh()}>重试</button>
              </>
            ) : loaded ? (
              '知识库为空。上传文档或安装专业化包以填充。'
            ) : (
              '加载中…'
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
                    <button className="btn-link danger" onClick={() => void doDelete(d.id)}>删除</button>
                  </span>
                </div>
                <div className="meta">{d.contentLength} 字符 · {new Date(d.createdAt).toLocaleString()}</div>
                {expanded && (
                  <div className="kb-doc-detail">
                    {viewDoc.tags?.length ? (
                      <div className="cap-tags" style={{ margin: '8px 0' }}>
                        {viewDoc.tags.map((t) => <span key={t} className="cap-tag">{t}</span>)}
                      </div>
                    ) : null}
                    <div className="kb-doc-content">{renderMarkdown(viewDoc.content, () => {})}</div>
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
        <div className="modal-mask" onClick={onCloseSettings}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>知识库设置</h3>
            <div className="settings-body">
              <KnowledgeSettingsPanel config={config} onSave={onSave} />
              <KnowledgeUploadPanel onToast={onToast} onUploaded={() => setKbRefreshToken((t) => t + 1)} />
              <div className="sub-model-card" style={{ marginBottom: 12 }}>
                <div className="sub-model-head">
                  <span className="sub-idx">知识空间与目录</span>
                </div>
                <div className="field-row">
                  <label className="field" style={{ maxWidth: 160 }}>
                    <span>库作用域</span>
                    <select value={listScope} onChange={(e) => { setListScope(e.target.value as 'global' | 'workspace'); setCurrentFolderId('') }}>
                      <option value="global">global（全局）</option>
                      <option value="workspace">workspace（工作区）</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span>知识空间</span>
                    <select value={currentSpaceId} onChange={(e) => switchSpace(e.target.value)}>
                      {spaces.length === 0 && <option value="">加载中…</option>}
                      {spaces.map((s) => <option key={s.id} value={s.id}>{s.builtin ? '★ ' : ''}{s.name}{s.id === defaultSpaceId ? '（默认）' : ''}</option>)}
                    </select>
                  </label>
                  {!currentSpace?.builtin && currentSpace && (
                    <label className="field" style={{ maxWidth: 90 }}>
                      <span>&nbsp;</span>
                      <button className="btn danger" onClick={() => void doDeleteSpace(currentSpace.id)}>删除空间</button>
                    </label>
                  )}
                </div>
                {currentSpace?.description && <div className="meta" style={{ margin: '4px 0 8px' }}>{currentSpace.description}</div>}
                <div className="field-row" style={{ marginBottom: 10 }}>
                  <input value={newSpaceName} placeholder="新空间名称，如 建筑工程规范" onChange={(e) => setNewSpaceName(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn" onClick={() => void doCreateSpace()}>新建空间</button>
                </div>
                <div className="kb-folders">
                  <div className={`kb-folder-row${currentFolderId === '' ? ' active' : ''}`}>
                    <button className="btn-link kb-folder-name" onClick={() => setCurrentFolderId('')}>全部文档</button>
                  </div>
                  {renderFolderTree(null)}
                  <div className="field-row" style={{ marginTop: 8 }}>
                    <input value={newFolderName} placeholder="目录名" onChange={(e) => setNewFolderName(e.target.value)} style={{ flex: 1 }} />
                    <button className="btn" onClick={() => void doCreateFolder(currentFolderId || null)}>新建目录</button>
                  </div>
                  <div className="meta">当前目录：{currentFolder ? currentFolder.name : '根目录（全部文档）'} · 共 {docs.length} 个词条</div>
                </div>
              </div>
            </div>
            <button className="btn" onClick={onCloseSettings}>关闭</button>
          </div>
        </div>
      )}
    </>
  )
}

/** 知识链接图谱：词条 × 标签的二分关系图（Three.js 真三维 + 扎哈流线 + 轨道旋转/缩放），点击节点预览内容。 */

// 模拟空间半边长（力导向布局范围）。
const KG_SPACE = 300
const clampv = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/* 编辑式 · 纸感奶白 × 陶土：珍珠奶白节点 + 软陶标签 + 暖灰流线，单点陶土强调。 */
const KG_ACCENT = 0xc0481c
const KG_DOC_COLOR = 0xf5f2ec
const KG_TAG_COLOR = 0xefd0c4
const KG_EDGE_COLOR = 0xb2a58f
const KG_COL_SEL = new THREE.Color(KG_ACCENT)
const KG_COL_HOVER = new THREE.Color(0xe6a988)
const KG_COL_NONE = new THREE.Color(0x000000)

/** Three.js 场景上下文（跨 React 渲染持久化，避免重复创建渲染器）。 */
type ThreeCtx = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  group: THREE.Group
  ring: THREE.Mesh
  raycaster: THREE.Raycaster
  pointer: THREE.Vector2
  nodeMeshes: THREE.Mesh[]
  edgeMeshes: THREE.Mesh[]
  raf: number
  ro: ResizeObserver | null
  hoverId: string | null
  bumpTex: THREE.Texture | null
}

/** 确定性哈希 → [0,1)，用于让每条流线以稳定而各异的角度弯曲。 */
function hashUnit(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/** 程序化纸张肌理：奶白底 + 细颗粒噪点 + 横向纤维丝 + 柔和斑驳，可无缝平铺。
 *  与页面保持一致纸感色 (#f3f0e9)，用于 3D 的纸感背景 / 纸感地面 / 节点纸浆凸感。 */
function makePaperTexture(): THREE.CanvasTexture {
  const size = 512
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#f3f0e9'
  ctx.fillRect(0, 0, size, size)

  // 细颗粒噪点：乘性明暗斑，模拟纸张纤维颗粒的微起伏。
  const img = ctx.getImageData(0, 0, size, size)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    px[i] = Math.max(0, Math.min(255, px[i] + n))
    px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n))
    px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)

  // 横向纤维丝：柔细长丝，跨上下边界各复制一份实现无缝平铺。
  ctx.lineWidth = 0.5
  for (let k = 0; k < 220; k++) {
    const y = Math.random() * size
    const len = size * (0.35 + Math.random() * 0.6)
    const x = Math.random() * size
    const bend = (Math.random() - 0.5) * 6
    const alpha = 0.03 + Math.random() * 0.05
    const tone = Math.random() > 0.5 ? '120,110,92' : '255,255,255'
    for (const off of [-size, 0, size]) {
      const gy = y + off
      const grad = ctx.createLinearGradient(x, gy, x + len, gy)
      grad.addColorStop(0, `rgba(${tone},0)`)
      grad.addColorStop(0.5, `rgba(${tone},${alpha})`)
      grad.addColorStop(1, `rgba(${tone},0)`)
      ctx.strokeStyle = grad
      ctx.beginPath()
      ctx.moveTo(x, gy)
      ctx.quadraticCurveTo(x + len / 2, gy + bend, x + len, gy)
      ctx.stroke()
    }
  }

  // 柔和斑驳：几团极淡明暗，模拟纸浆不匀，越界团块四周复制以无缝平铺。
  for (let k = 0; k < 26; k++) {
    const cx = Math.random() * size
    const cy = Math.random() * size
    const r = 40 + Math.random() * 120
    const light = Math.random() > 0.45
    const a = 0.02 + Math.random() * 0.03
    const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g2.addColorStop(0, light ? `rgba(255,255,255,${a})` : `rgba(150,138,116,${a})`)
    g2.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g2
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath()
        ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** 珍珠/浅玫瑰物理材质：清漆 + 虹彩 + 微绒面 + 纸浆颗粒凸感，浅色高级纸感。 */
function makeNodeMaterial(kind: 'doc' | 'tag', bump?: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: kind === 'doc' ? KG_DOC_COLOR : KG_TAG_COLOR,
    roughness: 0.3,
    metalness: 0.0,
    clearcoat: 0.65,
    clearcoatRoughness: 0.35,
    iridescence: 0.22,
    iridescenceIOR: 1.3,
    sheen: 0.36,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(kind === 'doc' ? 0xeae3d6 : 0xf6dcd2),
    bumpMap: bump ?? null,
    bumpScale: bump ? 0.5 : 0,
    transparent: true,
    opacity: 1,
    emissive: new THREE.Color(0x000000),
  })
}

/** 扎哈流线：节点间以二次贝塞尔弧线（TubeGeometry）相连，弯曲方向由哈希确定、彼此各异。 */
function makeEdgeTube(a: THREE.Vector3, b: THREE.Vector3, seed: number): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  const dist = dir.length() || 1
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
  const ref = Math.abs(dir.y) > 0.9 * dist ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const perp = new THREE.Vector3().crossVectors(dir, ref).normalize()
  const tilt = new THREE.Vector3().crossVectors(dir, perp).normalize()
  const bend = dist * 0.24
  const ang = seed * Math.PI * 2
  const ctrl = mid.clone().addScaledVector(perp, Math.cos(ang) * bend).addScaledVector(tilt, Math.sin(ang) * bend)
  const curve = new THREE.QuadraticBezierCurve3(a.clone(), ctrl, b.clone())
  const radius = Math.max(0.5, Math.min(1.4, dist * 0.006))
  const geo = new THREE.TubeGeometry(curve, 28, radius, 7, false)
  const mat = new THREE.MeshBasicMaterial({ color: KG_EDGE_COLOR, transparent: true, opacity: 0.32 })
  return new THREE.Mesh(geo, mat)
}

/** 释放 group 内所有网格的几何体与材质。 */
function disposeGroup(group: THREE.Group): void {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const c = group.children[i] as THREE.Mesh
    group.remove(c)
    if (c.geometry) c.geometry.dispose()
    const m = c.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(m)) m.forEach((x) => x.dispose())
    else if (m) m.dispose()
  }
}

function KnowledgeGraph({
  docs,
  onToast,
}: {
  docs: KnowledgeDoc[]
  onToast: (message: string) => void
}) {
  const [sel, setSel] = useState<{ kind: 'doc' | 'tag'; id: string } | null>(null)
  const [selDoc, setSelDoc] = useState<KnowledgeDocDetail | null>(null)
  const [fetching, setFetching] = useState(false)
  const [positions, setPositions] = useState<Map<string, { x: number; y: number; z: number }> | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ title: string; sub: string } | null>(null)

  const mountRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const threeRef = useRef<ThreeCtx | null>(null)
  const focusSetRef = useRef<Set<string> | null>(null)
  const selRef = useRef<{ kind: 'doc' | 'tag'; id: string } | null>(null)
  const selectNodeRef = useRef<(n: { kind: 'doc' | 'tag'; id: string }) => void>(() => {})

  const { nodes, edges } = useMemo(() => buildKnowledgeGraph(docs), [docs])

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of docs) for (const t of d.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }, [docs])

  // 三维力导向布局（收敛后一次性渲染，避免运行时抖动）
  useEffect(() => {
    if (!nodes.length) return
    const sim = nodes.map((n) => ({
      ...n,
      x: (Math.random() - 0.5) * KG_SPACE * 1.2,
      y: (Math.random() - 0.5) * KG_SPACE * 1.2,
      z: (Math.random() - 0.5) * KG_SPACE * 1.2,
    }))
    const idx = new Map(sim.map((n, i) => [n.id, i]))
    const adj = edges
      .map((e) => [idx.get(e.source), idx.get(e.target)])
      .filter((pair): pair is [number, number] => typeof pair[0] === 'number' && typeof pair[1] === 'number')
    for (let iter = 0; iter < 320; iter++) {
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const dx = sim[i].x - sim[j].x
          const dy = sim[i].y - sim[j].y
          const dz = sim[i].z - sim[j].z
          const d2 = dx * dx + dy * dy + dz * dz || 1
          const d = Math.sqrt(d2)
          const rf = (sim[i].kind === 'doc' ? 1.5 : 1) * (sim[j].kind === 'doc' ? 1.5 : 1)
          const f = Math.min(9000, (rf * 5200) / d2)
          const fx = (f * dx) / d
          const fy = (f * dy) / d
          const fz = (f * dz) / d
          sim[i].vx += fx
          sim[i].vy += fy
          sim[i].vz += fz
          sim[j].vx -= fx
          sim[j].vy -= fy
          sim[j].vz -= fz
        }
      }
      for (const [a, b] of adj) {
        const dx = sim[b].x - sim[a].x
        const dy = sim[b].y - sim[a].y
        const dz = sim[b].z - sim[a].z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
        const f = (sim[a].kind === 'doc' && sim[b].kind === 'doc' ? 0.004 : 0.01) * d
        const fx = (f * dx) / d
        const fy = (f * dy) / d
        const fz = (f * dz) / d
        sim[a].vx += fx
        sim[a].vy += fy
        sim[a].vz += fz
        sim[b].vx -= fx
        sim[b].vy -= fy
        sim[b].vz -= fz
      }
      for (const n of sim) {
        n.vx += -n.x * 0.006
        n.vy += -n.y * 0.006
        n.vz += -n.z * 0.006
        n.vx *= 0.86
        n.vy *= 0.86
        n.vz *= 0.86
        n.x += n.vx
        n.y += n.vy
        n.z += n.vz
      }
    }
    for (const n of sim) {
      n.x = clampv(n.x, -KG_SPACE, KG_SPACE)
      n.y = clampv(n.y, -KG_SPACE, KG_SPACE)
      n.z = clampv(n.z, -KG_SPACE, KG_SPACE)
    }
    setPositions(new Map(sim.map((n) => [n.id, { x: n.x, y: n.y, z: n.z }])))
  }, [nodes, edges])

  // 邻居关系
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set())
      if (!m.has(e.target)) m.set(e.target, new Set())
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [edges])

  const focusSet = useMemo(() => {
    if (!sel) return null
    const s = new Set<string>([sel.id])
    const nb = neighbors.get(sel.id)
    if (nb) for (const x of nb) s.add(x)
    return s
  }, [sel, neighbors])

  const groupDocs = (tag: string) => docs.filter((d) => d.tags?.includes(tag))

  const selectNode = async (n: { kind: 'doc' | 'tag'; id: string }) => {
    setSel(n)
    if (n.kind === 'doc') {
      setFetching(true)
      try {
        setSelDoc(await fetchKnowledgeDoc(n.id))
      } catch (e) {
        setSelDoc(null)
        onToast(e instanceof Error ? e.message : String(e))
      } finally {
        setFetching(false)
      }
    } else {
      setSelDoc(null)
    }
  }

  // 将最新的选中态 / 聚焦集合 / 选择回调写入 ref，供挂载一次的 Three.js 渲染循环读取。
  focusSetRef.current = focusSet
  selRef.current = sel
  selectNodeRef.current = (n) => {
    void selectNode(n)
  }

  // 挂载一次：创建渲染器 / 相机 / 灯光 / 轨道控制 / 地面柔影 / 选择轨道环，并启动渲染循环。
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0xf3f0e9, 980, 2500)

    // 程序化纸感：整面纸背景 + 纸感地面（同纹理，分别 Control 平铺参数）。
    const paperBack = makePaperTexture()
    paperBack.wrapS = paperBack.wrapT = THREE.ClampToEdgeWrapping
    scene.background = paperBack
    const paperGround = makePaperTexture()
    paperGround.repeat.set(36, 36)

    const camera = new THREE.PerspectiveCamera(42, 1, 1, 6000)
    camera.position.set(0, 200, 860)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.06
    renderer.domElement.className = 'kb-graph-canvas'
    mount.appendChild(renderer.domElement)

    // 扎哈浅色光环境：半球环境光 + 主光（柔影） + 冷调补光。
    scene.add(new THREE.HemisphereLight(0xffffff, 0xe6dfd0, 1.05))
    const key = new THREE.DirectionalLight(0xffffff, 1.5)
    key.position.set(240, 340, 200)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -KG_SPACE - 160
    key.shadow.camera.right = KG_SPACE + 160
    key.shadow.camera.top = KG_SPACE + 160
    key.shadow.camera.bottom = -KG_SPACE - 160
    key.shadow.camera.near = 50
    key.shadow.camera.far = 1500
    key.shadow.bias = -0.0004
    key.shadow.radius = 6
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xece5d8, 0.5)
    fill.position.set(-260, -140, -220)
    scene.add(fill)

    // 地面柔影 + 纸感：漂浮的形态落在带纸张肌理的纸面上。
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ map: paperGround, roughness: 1.0, metalness: 0, color: 0xdedad0 })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -KG_SPACE - 60
    ground.receiveShadow = true
    scene.add(ground)

    // 选择轨道环：扎哈式的绕行丝带，仅在选中节点时出现。
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.03, 12, 80),
      new THREE.MeshBasicMaterial({ color: KG_ACCENT, transparent: true, opacity: 0.85 })
    )
    ring.visible = false
    scene.add(ring)

    const group = new THREE.Group()
    scene.add(group)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.rotateSpeed = 0.65
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.55
    controls.minDistance = 280
    controls.maxDistance = 2400
    controls.target.set(0, 0, 0)

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const ctx: ThreeCtx = { renderer, scene, camera, controls, group, ring, raycaster, pointer, nodeMeshes: [], edgeMeshes: [], raf: 0, ro: null, hoverId: null, bumpTex: paperGround }
    threeRef.current = ctx

    const setSize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    setSize()
    const ro = new ResizeObserver(setSize)
    ro.observe(mount)
    ctx.ro = ro

    const el = renderer.domElement
    const updatePointer = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }
    const pick = (): THREE.Mesh | null => {
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(ctx.nodeMeshes, false)
      return hits.length ? (hits[0].object as THREE.Mesh) : null
    }
    const onMove = (e: PointerEvent) => {
      updatePointer(e)
      const hit = pick()
      const id = hit ? (hit.userData.id as string) : null
      if (id !== ctx.hoverId) {
        ctx.hoverId = id
        el.style.cursor = id ? 'pointer' : 'grab'
        if (hit) {
          const u = hit.userData
          setHoverInfo({ title: u.kind === 'doc' ? (u.label as string) : (u.tag as string), sub: u.kind === 'doc' ? '词条' : `标签 · ${u.count} 篇` })
        } else {
          setHoverInfo(null)
        }
      }
      if (hit && tipRef.current) {
        const rect = el.getBoundingClientRect()
        tipRef.current.style.left = `${e.clientX - rect.left + 14}px`
        tipRef.current.style.top = `${e.clientY - rect.top + 12}px`
      }
    }
    let downPos: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      if (!downPos) return
      const moved = Math.abs(e.clientX - downPos.x) + Math.abs(e.clientY - downPos.y)
      downPos = null
      if (moved > 6) return
      updatePointer(e)
      const hit = pick()
      if (hit) selectNodeRef.current({ kind: hit.userData.kind, id: hit.userData.id })
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)

    const tick = () => {
      ctx.raf = requestAnimationFrame(tick)
      controls.update()
      const focus = focusSetRef.current
      const selId = selRef.current?.id ?? null
      for (const m of ctx.nodeMeshes) {
        const id = m.userData.id as string
        const mat = m.material as THREE.MeshPhysicalMaterial
        const target = focus ? (focus.has(id) ? 1 : 0.16) : 1
        mat.opacity += (target - mat.opacity) * 0.12
        const isSel = id === selId
        const isHover = id === ctx.hoverId
        mat.emissive.lerp(isSel ? KG_COL_SEL : isHover ? KG_COL_HOVER : KG_COL_NONE, 0.15)
        const targetScale = isSel ? 1.18 : isHover ? 1.1 : 1
        m.scale.setScalar(m.scale.x + (targetScale - m.scale.x) * 0.15)
      }
      for (const t of ctx.edgeMeshes) {
        const a = t.userData.source as string
        const b = t.userData.target as string
        const mat = t.material as THREE.MeshBasicMaterial
        const target = focus ? (focus.has(a) && focus.has(b) ? 0.62 : 0.05) : 0.32
        mat.opacity += (target - mat.opacity) * 0.12
      }
      if (ring.visible) {
        ring.rotation.z += 0.012
        ring.rotation.x = Math.PI / 2.3 + Math.sin(performance.now() * 0.001) * 0.12
      }
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(ctx.raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      controls.dispose()
      disposeGroup(group)
      const ringMat = ring.material as THREE.Material
      ring.geometry.dispose()
      ringMat.dispose()
      const groundMat = ground.material as THREE.Material
      ground.geometry.dispose()
      groundMat.dispose()
      paperBack.dispose()
      paperGround.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      threeRef.current = null
    }
  }, [])

  // 依据力导向布局位置重建节点网格与流线管道（位置就绪后一次构建）。
  useEffect(() => {
    const ctx = threeRef.current
    if (!ctx || !positions) return
    disposeGroup(ctx.group)
    ctx.nodeMeshes = []
    ctx.edgeMeshes = []
    ctx.hoverId = null
    setHoverInfo(null)
    const nodePos = new Map<string, THREE.Vector3>()
    for (const n of nodes) {
      const p = positions.get(n.id)
      if (p) nodePos.set(n.id, new THREE.Vector3(p.x, p.y, p.z))
    }
    for (const e of edges) {
      const a = nodePos.get(e.source)
      const b = nodePos.get(e.target)
      if (!a || !b) continue
      const tube = makeEdgeTube(a, b, hashUnit(`${e.source}|${e.target}`))
      tube.userData = { source: e.source, target: e.target }
      ctx.group.add(tube)
      ctx.edgeMeshes.push(tube)
    }
    for (const n of nodes) {
      const p = nodePos.get(n.id)
      if (!p) continue
      const baseRadius = n.r * 1.5
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(baseRadius, 40, 28), makeNodeMaterial(n.kind, ctx.bumpTex))
      mesh.position.copy(p)
      mesh.castShadow = true
      mesh.userData = { id: n.id, kind: n.kind, label: n.label, tag: n.tag, count: n.kind === 'tag' ? tagCounts.get(n.tag ?? '') ?? 0 : 0, baseRadius }
      ctx.group.add(mesh)
      ctx.nodeMeshes.push(mesh)
    }
  }, [positions, nodes, edges, tagCounts])

  // 选择轨道环跟随选中节点。
  useEffect(() => {
    const ctx = threeRef.current
    if (!ctx) return
    const mesh = sel ? ctx.nodeMeshes.find((m) => m.userData.id === sel.id) : undefined
    if (mesh) {
      ctx.ring.visible = true
      ctx.ring.position.copy(mesh.position)
      ctx.ring.scale.setScalar((mesh.userData.baseRadius as number) * 2.1)
    } else {
      ctx.ring.visible = false
    }
  }, [sel, positions, nodes])

  return (
    <div className="kb-graph">
      <div className="kb-graph-hint">
        <span className="kg-legend"><i className="kg-dot doc" />词条</span>
        <span className="kg-legend"><i className="kg-dot tag" />标签</span>
        <span className="kg-tip">拖拽旋转 · 滚轮缩放 · 点击节点在下方预览</span>
      </div>
      <div ref={mountRef} className="kb-graph-3d">
        {(!positions || !docs.length) && (
          <div className="kg-empty">{docs.length ? '正在生成图谱…' : '知识库为空，上传文档后自动生成信息链接图谱。'}</div>
        )}
        <div ref={tipRef} className={`kg-tooltip${hoverInfo ? ' show' : ''}`}>
          {hoverInfo && (
            <>
              <div className="kg-tooltip-title">{hoverInfo.title}</div>
              <div className="kg-tooltip-sub">{hoverInfo.sub}</div>
            </>
          )}
        </div>
      </div>

      {sel && (
        <div className="kb-graph-preview">
          {sel.kind === 'doc' ? (
            selDoc ? (
              <>
                <div className="sub-model-head">
                  <span className="sub-idx">{selDoc.source} · {selDoc.title}</span>
                  <button className="btn-link" onClick={() => { setSel(null); setSelDoc(null) }}>收起</button>
                </div>
                <div className="meta">{selDoc.contentLength} 字符 · {selDoc.chunkCount} 分块 · {new Date(selDoc.createdAt).toLocaleString()}</div>
                {selDoc.tags?.length ? (
                  <div className="cap-tags" style={{ margin: '8px 0' }}>
                    {selDoc.tags.map((t) => <span key={t} className="cap-tag">{t}</span>)}
                  </div>
                ) : null}
                <div className="kb-doc-content">{renderMarkdown(selDoc.content, () => {})}</div>
              </>
            ) : (
              <div className="empty-hint">{fetching ? '加载词条中…' : '该词条无内容'}</div>
            )
          ) : (
            <>
              <div className="sub-model-head">
                <span className="sub-idx">标签「{sel.id.replace(/^tag:/, '')}」关联 {groupDocs(sel.id.replace(/^tag:/, '')).length} 个词条</span>
                <button className="btn-link" onClick={() => setSel(null)}>收起</button>
              </div>
              <div className="kb-graph-group">
                {groupDocs(sel.id.replace(/^tag:/, '')).map((d) => (
                  <button key={d.id} className="btn-link" onClick={() => void selectNode({ kind: 'doc', id: d.id })}>{d.title}（{d.chunkCount} 分块）</button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 根据分块数计算节点半径。 */
function clampNodeRadius(v: number, min: number, max: number): number {
  const s = Math.sqrt(Math.max(1, v))
  return Math.max(min, Math.min(max, 4 + s * 1.6))
}

/** 图谱节点：词条（doc）或标签（tag）。 */
type GraphNode = {
  id: string
  kind: 'doc' | 'tag'
  label: string
  doc?: KnowledgeDoc
  tag?: string
  r: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

/** 构建词条 × 标签二分图节点与边。 */
function buildKnowledgeGraph(docs: KnowledgeDoc[]): { nodes: GraphNode[]; edges: Array<{ source: string; target: string }> } {
  const nodes: GraphNode[] = []
  const edges: Array<{ source: string; target: string }> = []
  const tagFreq = new Map<string, number>()
  for (const d of docs) for (const t of d.tags ?? []) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1)
  for (const d of docs) {
    nodes.push({ id: d.id, kind: 'doc', label: d.title, doc: d, tag: undefined, r: clampNodeRadius(d.chunkCount, 5, 15), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
  }
  for (const [tag, freq] of tagFreq) {
    nodes.push({ id: `tag:${tag}`, kind: 'tag', label: tag, doc: undefined, tag, r: clampNodeRadius(freq, 3, 8), x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 })
  }
  for (const d of docs) for (const t of d.tags ?? []) edges.push({ source: d.id, target: `tag:${t}` })
  return { nodes, edges }
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
        <button className="btn-link" onClick={onBack}>← 返回对话</button>
        <span className="kb-page-title">知识库</span>
        <span className="kb-page-sub">自生长知识库</span>
        <button className="btn-link kb-settings-btn" title="知识库设置" onClick={() => setKbSettingsOpen(true)}>···</button>
      </header>
      <div className="kb-scroll kb-page-scroll">
        <KnowledgePanel onToast={onToast} config={config} onSave={onSave} settingsOpen={kbSettingsOpen} onCloseSettings={() => setKbSettingsOpen(false)} />
      </div>
    </main>
  )
}

/** 专业化能力包面板：安装 zip / 启停 / 移除。 */
function SpecPanel({ onToast }: { onToast: (message: string) => void }) {
  const [specs, setSpecs] = useState<SpecRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSpecs(await fetchSpecs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doInstall = async () => {
    if (!file) {
      setError('请先选择 .zip 能力包文件')
      return
    }
    setInstalling(true)
    setError('')
    try {
      const data = await fileToBase64(file)
      const spec = await installSpec(data)
      setFile(null)
      onToast(`已安装专业化包「${spec.name}」`)
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInstalling(false)
    }
  }

  const doToggle = async (s: SpecRecord) => {
    const ok = await setSpecEnabled(s.id, !s.enabled)
    if (ok) {
      onToast(`已${!s.enabled ? '启用' : '禁用'}「${s.name}」`)
      void refresh()
    }
  }

  const doRemove = async (s: SpecRecord) => {
    if (!confirm(`确定移除「${s.name}」？其技能与知识将不再参与。`)) return
    const ok = await removeSpec(s.id)
    if (ok) {
      onToast(`已移除「${s.name}」`)
      void refresh()
    }
  }

  return (
    <>
      <div className="section-hint">
        专业化能力包是面向专业领域的增量包（如建筑、电网），打包为 zip（内含 manifest.json + skills/*.yaml + knowledge/*）。
        安装后按包启用：技能注册进技能系统、内置知识文档入库到知识库；禁用后自动隔离，不影响普通用户。
      </div>

      <div className="sub-model-card" style={{ marginBottom: 12 }}>
        <div className="sub-model-head">
          <span className="sub-idx">安装专业化包</span>
        </div>
        <div className="field-row">
          <label className="field" style={{ flex: 1 }}>
            <span>选择 .zip 能力包</span>
            <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          {file && <div className="meta" style={{ alignSelf: 'flex-end' }}>{file.name}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => void doInstall()} disabled={installing || !file}>
            {installing ? '安装中…' : '安装并启用'}
          </button>
        </div>
        {error && <div className="meta" style={{ color: '#ff6b6b', marginTop: 8 }}>{error}</div>}
      </div>

      <div className="settings-section" style={{ maxHeight: 360 }}>
        {loading ? (
          <div className="empty-hint">加载中…</div>
        ) : specs.length === 0 ? (
          <div className="empty-hint">未安装任何专业化包。选择一个 .zip 能力包安装以扩展专业能力。</div>
        ) : (
          specs.map((s) => (
            <div key={s.id} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  {s.icon ?? '🧩'} {s.name} v{s.version} {s.category ? `[${s.category}]` : ''}
                  <span className="meta" style={{ color: s.enabled ? '#4caf50' : '#9e9e9e', marginLeft: 6 }}>
                    {s.enabled ? '已启用' : '已禁用'}
                  </span>
                </span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>{s.description || '（无简介）'}</div>
              <div className="meta">技能 {s.skillCount} 个 · 知识文档 {s.knowledgeCount} 篇 · {new Date(s.installedAt).toLocaleString()}</div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => void doToggle(s)}>
                  {s.enabled ? '禁用' : '启用'}
                </button>
                <button className="btn-link danger" onClick={() => void doRemove(s)}>移除</button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'user' | 'project' | 'auto'>('auto')
  const [tags, setTags] = useState('')
  const [q, setQ] = useState('')
  const [filterScope, setFilterScope] = useState<'all' | 'user' | 'project' | 'auto'>('all')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterScope !== 'all') params.set('scope', filterScope)
      if (q) params.set('q', q)
      const res = await apiFetch(`/api/memory?${params}`)
      if (res.ok) {
        const data = (await res.json()) as { entries: MemoryEntry[] }
        setEntries(data.entries)
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [filterScope, q])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const addMemory = async () => {
    const c = content.trim()
    if (!c) return
    try {
      const res = await apiFetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: c,
          scope,
          tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        }),
      })
      if (res.ok) {
        setContent('')
        setTags('')
        void refresh()
      }
    } catch {
      /* ignore */
    }
  }

  const removeMemory = async (id: string) => {
    try {
      const res = await apiFetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) void refresh()
    } catch {
      /* ignore */
    }
  }

  const clearAll = async () => {
    if (!confirm('确定清空全部记忆？此操作不可撤销。')) return
    try {
      await apiFetch('/api/memory/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      void refresh()
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <div className="section-hint">
        AI 会自动将相关记忆注入到每次对话的 systemPrompt（user {'>'} project {'>'} auto 排序，4KB 截断）。
        AI 运行时也可调用 <code>remember</code> / <code>recall</code> 工具。
      </div>

      <div className="sub-model-card">
        <div className="sub-model-head">
          <span className="sub-idx">添加记忆</span>
        </div>
        <label className="field">
          <span>内容</span>
          <input value={content} placeholder="要记住的事实或偏好" onChange={(e) => setContent(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>作用域</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'user' | 'project' | 'auto')}>
              <option value="user">user（跨项目偏好）</option>
              <option value="project">project（项目上下文）</option>
              <option value="auto">auto（自动学习）</option>
            </select>
          </label>
          <label className="field">
            <span>标签（逗号分隔）</span>
            <input value={tags} placeholder="code-style, tech-stack" onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>
        <button className="btn primary" onClick={addMemory} disabled={!content.trim()}>
          添加
        </button>
      </div>

      <div className="field-row" style={{ marginBottom: 12 }}>
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="field">
          <span>作用域</span>
          <select value={filterScope} onChange={(e) => setFilterScope(e.target.value as 'all' | 'user' | 'project' | 'auto')}>
            <option value="all">全部</option>
            <option value="user">user</option>
            <option value="project">project</option>
            <option value="auto">auto</option>
          </select>
        </label>
      </div>

      <div className="settings-section" style={{ maxHeight: 280 }}>
        {loading ? (
          <div className="empty-hint">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="empty-hint">无记忆。AI 运行时调用 remember 工具或在此添加。</div>
        ) : (
          entries.map((e) => (
            <div key={e.id} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  [{e.scope}] {e.tags?.length ? ` {${e.tags.join(',')}}` : ''}
                </span>
                <button className="btn-link danger" onClick={() => void removeMemory(e.id)}>
                  删除
                </button>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>{e.content}</div>
              {e.workspace && <div className="meta">@{e.workspace}</div>}
            </div>
          ))
        )}
      </div>

      {entries.length > 0 && (
        <button className="btn-link danger" onClick={void clearAll} style={{ marginTop: 8 }}>
          清空全部
        </button>
      )}
    </>
  )
}

interface SkillEntry {
  name: string
  description: string
  icon?: string
  category?: string
  tags?: string[]
  template?: string
  inputs?: Record<string, unknown>
  tools?: string[]
  version?: string
  visibility?: string
  memory?: { scope: string; tags?: string[] }
}

interface SkillUploadCandidate {
  sourceFile: string
  skill: SkillEntry | null
  issues: string[]
  review: {
    status: 'approve' | 'reject' | 'needs_fix' | 'skipped'
    feedback: string
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const UPLOAD_ACCEPT = '.yaml,.yml,.zip'

function SkillPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newTemplate, setNewTemplate] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [runSkill, setRunSkill] = useState<SkillEntry | null>(null)
  const [runArgs, setRunArgs] = useState('{}')
  const [runResult, setRunResult] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadScope, setUploadScope] = useState<'global' | 'project'>('global')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadCandidates, setUploadCandidates] = useState<SkillUploadCandidate[]>([])
  const [installing, setInstalling] = useState('')
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/skills?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const data = (await res.json()) as { skills: SkillEntry[] }
        setSkills(data.skills)
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function addSkill() {
    const res = await apiFetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newName,
        description: newDesc,
        template: newTemplate,
        category: newCategory || undefined,
        inputs: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        tools: ['read_file', 'shell'],
      }),
    })
    if (res.ok) {
      setShowAdd(false)
      setNewName('')
      setNewDesc('')
      setNewTemplate('')
      setNewCategory('')
      void refresh()
    }
  }

  async function removeSkill(name: string) {
    await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
    void refresh()
  }

  async function executeSkill() {
    if (!runSkill) return
    let args = {}
    try {
      args = JSON.parse(runArgs)
    } catch {
      setRunResult('✗ 参数必须是合法 JSON')
      return
    }
    const res = await apiFetch(`/api/skills/${encodeURIComponent(runSkill.name)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    })
    const data = (await res.json()) as { prompt?: string; error?: string }
    setRunResult(data.error ? `✗ ${data.error}` : data.prompt ?? '')
  }

  async function performUpload() {
    if (!uploadFiles.length) {
      setUploadError('请先选择 .yaml/.yml/.zip 文件')
      return
    }
    setUploading(true)
    setUploadError('')
    setUploadCandidates([])
    try {
      const files = await Promise.all(
        uploadFiles.map(async (f) => ({ name: f.name, dataBase64: await fileToBase64(f) })),
      )
      const res = await apiFetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, review: true }),
      })
      const data = (await res.json()) as { candidates?: SkillUploadCandidate[]; error?: string }
      if (!res.ok) {
        setUploadError(data.error ?? `上传失败（HTTP ${res.status}）`)
        return
      }
      setUploadCandidates(data.candidates ?? [])
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  async function installCandidate(c: SkillUploadCandidate) {
    if (!c.skill) return
    setInstalling(c.sourceFile)
    setUploadError('')
    try {
      const res = await apiFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill: c.skill, scope: uploadScope }),
      })
      const data = (await res.json()) as { skill?: SkillEntry; dir?: string; error?: string }
      if (!res.ok) {
        setUploadError(data.error ?? `安装失败（HTTP ${res.status}）`)
        return
      }
      setUploadCandidates([])
      setUploadFiles([])
      setShowUpload(false)
      void refresh()
      setUploadError(`✓ 已安装到 ${uploadScope === 'global' ? '全局' : '当前项目'}`)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling('')
    }
  }

  return (
    <>
      <div className="section-hint">
        技能是可复用的提示词模板 + 输入参数 + 工具子集。对话中输入 <code>/skill name args</code> 调用，
        或让 AI 自动调用 <code>use_skill</code> 工具。
      </div>

      <div className="field-row" style={{ marginBottom: 12 }}>
        <label className="field">
          <span>搜索</span>
          <input value={q} placeholder="名称/描述关键词" onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          + 新建
        </button>
        <button className="btn" onClick={() => { setShowUpload(true); setUploadError(''); setUploadCandidates([]) }}>
          ⬆ 上传
        </button>
      </div>

      {showUpload && (
        <div className="sub-model-card" style={{ marginBottom: 12 }}>
          <div className="sub-model-head">
            <span className="sub-idx">上传技能（.yaml / .zip 批量）</span>
            <button className="btn-link" onClick={() => setShowUpload(false)}>
              关闭
            </button>
          </div>
          <div className="field-row" style={{ marginBottom: 8 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>选择文件</span>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={(e) => setUploadFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <label className="field" style={{ maxWidth: 160 }}>
              <span>安装位置</span>
              <select value={uploadScope} onChange={(e) => setUploadScope(e.target.value as 'global' | 'project')}>
                <option value="global">全局</option>
                <option value="project">当前项目</option>
              </select>
            </label>
          </div>
          {uploadFiles.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
              已选：{uploadFiles.map((f) => f.name).join('、')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void performUpload()} disabled={uploading || !uploadFiles.length}>
              {uploading ? '解析中…' : '上传并审核'}
            </button>
            <button className="btn" onClick={() => { setUploadFiles([]); setUploadCandidates([]); setUploadError('') }}>
              清空
            </button>
          </div>
          {uploadError && <div className="meta" style={{ color: uploadError.startsWith('✓') ? '#4caf50' : '#ff6b6b', marginTop: 8 }}>{uploadError}</div>}
          {uploadCandidates.length > 0 && (
            <div className="settings-section" style={{ maxHeight: 300, marginTop: 10 }}>
              {uploadCandidates.map((c, i) => {
                const ok = c.review.status !== 'reject' && c.issues.length === 0 && !!c.skill
                return (
                  <div key={`${c.sourceFile}-${i}`} className="sub-model-card">
                    <div className="sub-model-head">
                      <span className="sub-idx">
                        {c.skill?.icon ?? '📄'} {c.sourceFile} · {c.skill?.name ?? '无效'}
                      </span>
                      <span
                        className="meta"
                        style={{
                          color:
                            c.review.status === 'approve' ? '#4caf50'
                              : c.review.status === 'reject' ? '#ff6b6b'
                                : c.review.status === 'needs_fix' ? '#ffa726'
                                  : '#9e9e9e',
                        }}
                      >
                        {c.review.status === 'approve' ? 'AI 通过'
                          : c.review.status === 'reject' ? 'AI 拒绝'
                            : c.review.status === 'needs_fix' ? '需修正'
                              : '未审核'}
                      </span>
                    </div>
                    {c.skill?.description && <div style={{ fontSize: 13, lineHeight: 1.6 }}>{c.skill.description}</div>}
                    {c.review.feedback && <div className="meta" style={{ marginTop: 4 }}>意见：{c.review.feedback}</div>}
                    {c.issues.length > 0 && (
                      <div className="meta" style={{ color: '#ff6b6b', marginTop: 4 }}>
                        问题：{c.issues.join('；')}
                      </div>
                    )}
                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                      <button
                        className="btn primary"
                        disabled={!ok || installing === c.sourceFile}
                        onClick={() => void installCandidate(c)}
                      >
                        {installing === c.sourceFile ? '安装中…' : '安装'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <div className="sub-model-card" style={{ marginBottom: 12 }}>
          <div className="sub-model-head">
            <span className="sub-idx">新建技能</span>
            <button className="btn-link" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
          <label className="field">
            <span>名称</span>
            <input value={newName} placeholder="如 code-review" onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label className="field">
            <span>描述</span>
            <input value={newDesc} placeholder="技能用途" onChange={(e) => setNewDesc(e.target.value)} />
          </label>
          <label className="field">
            <span>分类</span>
            <input value={newCategory} placeholder="如 dev / writing" onChange={(e) => setNewCategory(e.target.value)} />
          </label>
          <label className="field">
            <span>提示词模板（含 {`{{input}}`} 占位符）</span>
            <textarea
              value={newTemplate}
              placeholder="你是专家。处理：{{input}}"
              onChange={(e) => setNewTemplate(e.target.value)}
              rows={4}
              style={{ fontFamily: 'monospace' }}
            />
          </label>
          <button className="btn primary" onClick={addSkill} disabled={!newName.trim() || !newTemplate.trim()}>
            保存
          </button>
        </div>
      )}

      <div className="settings-section" style={{ maxHeight: 360 }}>
        {loading ? (
          <div className="empty-hint">加载中…</div>
        ) : skills.length === 0 ? (
          <div className="empty-hint">无技能。点击「+ 新建」创建。</div>
        ) : (
          skills.map((s) => (
            <div key={s.name} className="sub-model-card">
              <div className="sub-model-head">
                <span className="sub-idx">
                  {s.icon ?? '📌'} {s.name} {s.category ? `[${s.category}]` : ''}
                </span>
                <div>
                  <button className="btn-link" onClick={() => { setRunSkill(s); setRunArgs('{}'); setRunResult('') }}>
                    运行
                  </button>
                  <button className="btn-link danger" onClick={() => void removeSkill(s.name)}>
                    删除
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>{s.description}</div>
              {s.tools?.length ? <div className="meta">工具：{s.tools.join(', ')}</div> : null}
              {runSkill?.name === s.name && (
                <div style={{ marginTop: 8, padding: 8, background: 'rgba(0,0,0,0.2)', borderRadius: 6 }}>
                  <label className="field">
                    <span>参数（JSON）</span>
                    <textarea
                      value={runArgs}
                      onChange={(e) => setRunArgs(e.target.value)}
                      rows={2}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                  </label>
                  <button className="btn primary" style={{ marginTop: 4 }} onClick={() => void executeSkill()}>
                    执行
                  </button>
                  {runResult && (
                    <pre style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                      {runResult}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  )
}

interface ToolEntry {
  name: string
  description: string
  schema: Record<string, unknown>
}

function ToolPanel() {
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ToolEntry | null>(null)
  const [args, setArgs] = useState('{}')
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const res = await apiFetch('/api/tools')
        if (res.ok) {
          const data = (await res.json()) as { tools: ToolEntry[] }
          setTools(data.tools)
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function testTool() {
    if (!selected) return
    let parsed = {}
    try {
      parsed = JSON.parse(args)
    } catch {
      setResult('✗ 参数必须是合法 JSON')
      return
    }
    setRunning(true)
    setResult('')
    try {
      const res = await apiFetch(`/api/tools/${encodeURIComponent(selected.name)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: parsed }),
      })
      const data = (await res.json()) as { result?: unknown; error?: string }
      setResult(data.error ? `✗ ${data.error}` : JSON.stringify(data.result, null, 2))
    } catch (err) {
      setResult(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const schemaProps = (selected?.schema as { properties?: Record<string, { type?: string; description?: string }> })?.properties ?? {}
  const required = (selected?.schema as { required?: string[] })?.required ?? []

  return (
    <>
      <div className="section-hint">
        选择一个已注册的工具，输入参数（JSON），点击执行查看结果。这是扣子式的「试运行」面板。
      </div>

      <div className="settings-section" style={{ maxHeight: 200, marginBottom: 12 }}>
        {loading ? (
          <div className="empty-hint">加载中…</div>
        ) : tools.length === 0 ? (
          <div className="empty-hint">无工具</div>
        ) : (
          tools.map((t) => (
            <button
              key={t.name}
              className={`sub-model-card ${selected?.name === t.name ? 'active' : ''}`}
              style={{ cursor: 'pointer', textAlign: 'left', width: '100%', marginBottom: 4 }}
              onClick={() => { setSelected(t); setArgs('{}'); setResult('') }}
            >
              <div style={{ fontWeight: 600 }}>{t.name}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{t.description.slice(0, 100)}</div>
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="sub-model-card">
          <div className="sub-model-head">
            <span className="sub-idx">{selected.name}</span>
          </div>
          <div style={{ fontSize: 13, marginBottom: 8 }}>{selected.description}</div>
          {Object.keys(schemaProps).length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.7 }}>
              参数：{Object.entries(schemaProps).map(([k, v]) => `${k}(${v.type ?? 'any'})`).join(', ')}
              {required.length > 0 && ` · 必填：${required.join(', ')}`}
            </div>
          )}
          <label className="field">
            <span>参数（JSON）</span>
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              rows={3}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </label>
          <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void testTool()} disabled={running}>
            {running ? '执行中…' : '执行'}
          </button>
          {result && (
            <pre style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>
              {result}
            </pre>
          )}
        </div>
      )}
    </>
  )
}

function UpdatePanel() {
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null)
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function doCheck() {
    setChecking(true)
    setMessage('')
    setCheckResult(null)
    try {
      setCheckResult(await checkUpdate())
    } catch (err) {
      setMessage(`检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }

  async function doUpdate() {
    setUpdating(true)
    setMessage('')
    try {
      const r = await triggerUpdate()
      setMessage(r.ok ? (r.message ?? '已提交更新，即将重启服务') : `更新失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setMessage(`更新失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUpdating(false)
    }
  }

  async function onFile(input: HTMLInputElement) {
    const file = input.files?.[0]
    if (!file) return
    setMessage('')
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      const r = await installUpdateZip(data, file.name)
      setMessage(r.ok ? (r.message ?? '已安装增量包，即将重启服务') : `安装失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setMessage(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      input.value = ''
    }
  }

  return (
    <>
      <div className="section-hint">
        应用内更新：在线检查新版本并全自动下载应用，或手动安装本地增量包（.zip）。
      </div>

      <div className="sub-model-card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>在线更新</div>
        {checkResult && (
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            当前版本：{checkResult.currentVersion}
            {checkResult.hasUpdate ? (
              <> · 最新版本：{checkResult.latestVersion}（可更新）</>
            ) : (
              <> · 已是最新版本</>
            )}
            {checkResult.releaseNotes && (
              <div style={{ marginTop: 4, opacity: 0.7 }}>{checkResult.releaseNotes}</div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => void doCheck()} disabled={checking || updating}>
            {checking ? '检查中…' : '检查更新'}
          </button>
          <button
            className="btn primary"
            onClick={() => void doUpdate()}
            disabled={!checkResult?.hasUpdate || updating || checking}
          >
            {updating ? '更新中…' : '立即更新'}
          </button>
        </div>
      </div>

      <div className="sub-model-card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>手动安装增量包</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          选择本地 .zip 增量包进行离线更新，安装后会自动重启服务。
        </div>
        <input ref={fileRef} type="file" accept=".zip" onChange={(e) => void onFile(e.target)} />
      </div>

      {message && <div className="section-hint" style={{ marginTop: 12 }}>{message}</div>}
    </>
  )
}
