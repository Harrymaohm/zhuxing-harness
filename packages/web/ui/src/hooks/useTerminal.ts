import { useCallback, useEffect, useRef, useState } from 'react'

import { apiFetch } from '../api'

/** 一条命令的执行记录（同一回合的 stdout/stderr 合并为可复制的 output）。 */
export interface TerminalEntry {
  id: string
  command: string
  /** 合并后的输出文本（stdout 与 stderr 按到达顺序拼接）。 */
  output: string
  running: boolean
  code: number | null
  signal: string | null
  /** 触达墙钟上限而被终止。 */
  timedOut: boolean
  /** 输出触达上限而被截断。 */
  truncated: boolean
  wallMs: number | null
  /** 实际执行目录（来自服务端 ready 事件）。 */
  cwd?: string
  /** 未进入执行阶段就被拒绝（沙箱不允许 / 参数非法）。 */
  error?: string
  /** 客户端主动停止。 */
  aborted?: boolean
}

function sseFrames(buffer: string): { frames: Array<{ event: string; data: string }>; rest: string } {
  const frames: Array<{ event: string; data: string }> = []
  let rest = buffer
  for (;;) {
    const at = rest.indexOf('\n\n')
    if (at < 0) break
    const raw = rest.slice(0, at)
    rest = rest.slice(at + 2)
    let event = 'message'
    const dataLines: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') })
  }
  return { frames, rest }
}

/**
 * 交互式终端的客户端状态。
 *
 * 输出按帧到达，逐帧 setState 会让长输出把主线程刷爆；因此把文本先攒进 ref，
 * 每个动画帧最多合并提交一次（结构变化如退出码、错误则立即提交）。
 */
export function useTerminal() {
  const [entries, setEntries] = useState<TerminalEntry[]>([])
  const [running, setRunning] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const pendingRef = useRef(new Map<string, string>())
  const flushScheduledRef = useRef(false)

  const flush = useCallback(() => {
    flushScheduledRef.current = false
    const pending = pendingRef.current
    if (pending.size === 0) return
    pendingRef.current = new Map()
    setEntries((prev) => prev.map((e) => (pending.has(e.id) ? { ...e, output: e.output + pending.get(e.id) } : e)))
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return
    flushScheduledRef.current = true
    // 用 setTimeout 而不是 requestAnimationFrame：后台标签页里 rAF 完全不触发，
    // 终端输出会一直憋到用户切回来才出现（隐藏标签页的 setTimeout 只是被降频到约 1s，仍会执行）。
    setTimeout(() => flush(), 16)
  }, [flush])

  const patch = useCallback((id: string, next: Partial<TerminalEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...next } : e)))
  }, [])

  // 卸载时断开在跑的请求，避免命令在前端已消失却仍在后台跑
  useEffect(() => () => abortRef.current?.abort(), [])

  const run = useCallback(async (command: string) => {
    const trimmed = command.trim()
    if (!trimmed) return
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setEntries((prev) => [
      ...prev,
      { id, command: trimmed, output: '', running: true, code: null, signal: null, timedOut: false, truncated: false, wallMs: null },
    ])
    setRunning(true)

    const ac = new AbortController()
    abortRef.current = ac
    try {
      const res = await apiFetch('/api/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed }),
        signal: ac.signal,
      })

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        patch(id, { running: false, error: body.error ?? `执行失败（HTTP ${res.status}）` })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const { frames, rest } = sseFrames(buf)
        buf = rest
        for (const frame of frames) {
          if (frame.event === 'ready') {
            const data = JSON.parse(frame.data) as { cwd?: string }
            patch(id, { cwd: data.cwd })
            continue
          }
          if (frame.event === 'chunk') {
            const data = JSON.parse(frame.data) as { text?: string }
            pendingRef.current.set(id, (pendingRef.current.get(id) ?? '') + (data.text ?? ''))
            scheduleFlush()
            continue
          }
          if (frame.event === 'exit') {
            const data = JSON.parse(frame.data) as { code?: number | null; signal?: string | null; timedOut?: boolean; truncated?: boolean; wallMs?: number }
            flush()
            patch(id, {
              running: false,
              code: data.code ?? null,
              signal: data.signal ?? null,
              timedOut: Boolean(data.timedOut),
              truncated: Boolean(data.truncated),
              wallMs: data.wallMs ?? null,
            })
            continue
          }
          if (frame.event === 'error') {
            const data = JSON.parse(frame.data) as { message?: string }
            flush()
            patch(id, { running: false, error: data.message ?? '执行出错' })
          }
        }
      }
    } catch (err) {
      flush()
      const aborted = ac.signal.aborted
      patch(id, {
        running: false,
        aborted,
        error: aborted ? undefined : err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      setRunning(false)
    }
  }, [flush, patch, scheduleFlush])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clear = useCallback(() => {
    pendingRef.current = new Map()
    setEntries([])
  }, [])

  return { entries, running, run, stop, clear }
}
