/**
 * 交互式终端：把用户在界面上敲的命令交给**同一个沙箱**裁决后执行，输出以 SSE 流式回传。
 *
 * 三条硬约束：
 *
 * 1. **与 AI 的 shell 工具同源裁决**。命令先过 `createSandbox({ level, workspace }).checkCommand`，
 *    与 Agent 调 shell 时走的是同一套策略（同一个 sandbox 包、同一份档位），不在服务端另立一套。
 *    否则会出现「AI 在 workspace-write 下不能写盘、用户却能」的口子，沙箱就形同虚设。
 *
 * 2. **输出脱敏且有限**。复用 kernel 的 maskSecrets，并设字节上限与墙钟上限：
 *    终端是唯一能把任意文本灌进浏览器的通道，不设限就等于给了个内存炸弹。
 *
 * 3. **断连即杀**。客户端关掉 SSE（点停止 / 关页 / 断网）就结束整棵进程树，
 *    否则 `npm run dev` 这类常驻命令会在后台留一堆孤儿进程。
 *
 * 已知边界：不做 PTY。需要 tty 交互的程序（vim/top/交互式登录）无法使用；
 * 也不接 stdin，需要 y/N 确认的命令会一直等到墙钟上限。
 */

import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'

import { createSandbox, DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { maskSecrets } from '@zhuxing/harness-kernel'

/** 单条命令的长度上限：终端输入框不该成为任意载荷通道。 */
const MAX_COMMAND_CHARS = 4_000

/** 墙钟上限：足够跑构建与测试，又不至于让失联的常驻命令永远挂着。 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** 输出上限：超过即截断并终止，避免把页面打爆。 */
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024

export interface TerminalExecOptions {
  command: string
  /** 执行目录（与 Agent 使用同一个 workspace）。 */
  cwd: string
  /** 沙箱档位：必须与配置里的 level 一致。 */
  level?: PermissionLevel
  timeoutMs?: number
  maxOutputBytes?: number
  /** 终止进程树的兜底宽限期。 */
  killGraceMs?: number
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 逐流转码器。
 *
 * Windows 上 cmd.exe 自己的报错信息按 OEM 代码页（简体中文为 GBK）输出，而多数现代工具
 * 按 UTF-8 输出——同一台机器上两种编码并存。这里用「严格 UTF-8 判定」区分：
 * UTF-8 合法就按 UTF-8 解；一旦出现非法字节序列，就判定该条流是 GBK 并固定下来。
 * 用 `{ stream: true }` 让解码器自己缓存被切断的多字节序列，避免分块边界产生乱码。
 */
function createDecoder(): (buf: Buffer) => string {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const gbk = process.platform === 'win32' ? new TextDecoder('gbk') : null
  let useGbk = false
  return (buf: Buffer): string => {
    if (useGbk && gbk) return gbk.decode(buf, { stream: true })
    try {
      return utf8.decode(buf, { stream: true })
    } catch {
      useGbk = true
      return gbk ? gbk.decode(buf, { stream: true }) : new TextDecoder('utf-8').decode(buf)
    }
  }
}

/** 结束整棵进程树：`shell: true` 时子进程是 shell，必须按树杀才不会留孙子进程。 */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 进程可能已退出 */
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 进程可能已退出 */
  }
}

/**
 * 处理一次终端执行请求。校验失败在切 SSE 之前就用 JSON 拒绝，
 * 这样客户端能收到明确的 403/400，而不是一个空流。
 */
export function handleTerminalExec(res: ServerResponse, opts: TerminalExecOptions): void {
  const command = String(opts.command ?? '')
  if (!command.trim()) {
    json(res, 400, { error: '命令不能为空' })
    return
  }
  if (command.length > MAX_COMMAND_CHARS) {
    json(res, 400, { error: `命令过长（上限 ${MAX_COMMAND_CHARS} 字符）` })
    return
  }

  const level = opts.level ?? DEFAULT_PERMISSION_LEVEL
  try {
    createSandbox({ level, workspace: opts.cwd }).checkCommand(command)
  } catch (err) {
    json(res, 403, { error: maskSecrets(err instanceof Error ? err.message : String(err)) })
    return
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  let child: ReturnType<typeof spawn> | null = null
  let bytes = 0
  let truncated = false
  let timedOut = false
  let settled = false
  const startedAt = Date.now()

  const send = (event: string, data: unknown) => {
    if (!closed) sse(res, event, data)
  }

  const finish = (payload: Record<string, unknown>) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    send('exit', { ...payload, wallMs: Date.now() - startedAt, truncated })
  }

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child?.pid)
  }, timeoutMs)

  res.once('close', () => {
    closed = true
    // 客户端主动断开（点停止 / 关页）→ 结束进程树
    if (!settled) {
      settled = true
      clearTimeout(timer)
      killTree(child?.pid)
    }
  })

  try {
    // shell: true 走平台原生解释器（Windows 为 cmd.exe），与沙箱对命令语法的假设一致
    child = spawn(command, { cwd: opts.cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    send('error', { message: maskSecrets(err instanceof Error ? err.message : String(err)) })
    finish({ code: null, signal: null })
    res.end()
    return
  }

  send('ready', { pid: child.pid ?? null, cwd: opts.cwd, level, command })

  const onData = (stream: 'stdout' | 'stderr') => {
    const decode = createDecoder()
    return (buf: Buffer) => {
      if (truncated) return
      bytes += buf.length
      if (bytes > maxOutputBytes) {
        truncated = true
        send('chunk', { stream, text: `\n[输出超过 ${Math.round(maxOutputBytes / 1024)} KB，已截断并终止]\n` })
        killTree(child?.pid)
        return
      }
      send('chunk', { stream, text: maskSecrets(decode(buf)) })
    }
  }

  child.stdout?.on('data', onData('stdout'))
  child.stderr?.on('data', onData('stderr'))

  child.once('error', (err) => {
    send('error', { message: maskSecrets(err.message) })
    finish({ code: null, signal: null })
    res.end()
  })

  child.once('close', (code, signal) => {
    finish({ code, signal, timedOut })
    res.end()
  })
}
