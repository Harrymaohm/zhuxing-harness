/**
 * stdio 传输层：把 MCP server 作为子进程拉起，负责帧收发与**进程生命周期**。
 *
 * 规范依据（2026-07-28 / 2025-06-18 的 `basic/transports/stdio`）：
 * - 客户端只写请求与通知（MUST NOT 写响应）——本文件只做「写一行 JSON-RPC」这一件事；
 * - 关闭顺序：关 stdin → 等服务端退出 → 超时后强杀（POSIX 用 SIGTERM→SIGKILL；Windows 用
 *   `taskkill /T /F` 以便连带子进程——沿用 packages/web/src/terminal.ts 的既有做法）；
 * - stderr 归日志，**不得假定 stderr 即出错**，故按 debug 级别转发；
 * - stdout 只允许 MCP 消息：非 MCP 内容告警后丢弃，不崩。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Logger } from '@zhuxing/harness-kernel'
import { encodeMessage, LineBuffer, parseLine } from './framing.js'

export interface StdioExitInfo {
  code: number | null
  signal: string | null
  /** true = 本客户端主动关闭（正常收尾）；false = 意外退出。 */
  expected: boolean
}

export interface StdioTransportHandlers {
  onMessage(message: Record<string, unknown>): void
  onExit(info: StdioExitInfo): void
}

export interface StdioTransportOptions {
  serverName: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
  logger: Logger
  /** 关 stdin 后等待自行退出的时间。 */
  shutdownGraceMs?: number
  /** 强杀后等待退出的时间（POSIX 的 SIGTERM 与 SIGKILL 各等一次）。 */
  signalGraceMs?: number
}

/**
 * Windows 下 `npx` / `uvx` / `pnpm` 这类命令是 `.cmd`/`.ps1` 垫片，**不能**直接 spawn：
 * Node 只在 `shell: true` 时才经 cmd.exe 解析它们。因此 Windows 上除 `.exe` 外一律走 shell；
 * 走 shell 时必须自己给含空白的参数加引号（Node 不做逐参数引号）。
 * 局限（已知且如实记录）：参数里含 `"` 或 `%VAR%` 时 cmd.exe 的解析规则会介入，这类极端参数不保证原样透传。
 */
function needsWindowsShell(command: string): boolean {
  return process.platform === 'win32' && !/\.exe$/i.test(command)
}

function quoteForWindowsShell(arg: string): string {
  if (arg === '') return '""'
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

export class StdioTransport {
  private child: ChildProcess | undefined
  private readonly lineBuffer = new LineBuffer()
  private closing = false
  private exited = false
  private exitPromise: Promise<void> = Promise.resolve()
  private resolveExit: (() => void) | undefined
  private warnedOverflow = false

  constructor(
    private readonly opts: StdioTransportOptions,
    private readonly handlers: StdioTransportHandlers,
  ) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.exited
  }

  /** 拉起子进程；`spawn` 失败（如命令不存在）以可读错误 reject。 */
  start(): Promise<void> {
    const { command, args, env, cwd, logger, serverName } = this.opts
    const useShell = needsWindowsShell(command)
    const finalArgs = useShell ? args.map(quoteForWindowsShell) : args
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(command, finalArgs, {
          cwd,
          env: env ? { ...process.env, ...env } : process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: useShell,
        })
      } catch (err) {
        reject(new Error(`MCP server "${serverName}" 启动失败：${err instanceof Error ? err.message : String(err)}`))
        return
      }
      this.child = child
      this.exitPromise = new Promise<void>((res) => {
        this.resolveExit = res
      })
      let settled = false
      child.once('spawn', () => {
        settled = true
        logger.debug(`[mcp:${serverName}] 子进程已启动（pid=${child.pid}${useShell ? '，经 cmd.exe' : ''}）`)
        resolve()
      })
      child.once('error', (err) => {
        const message = `MCP server "${serverName}" 进程错误：${err.message}`
        if (!settled) {
          settled = true
          this.exited = true
          reject(new Error(message))
          return
        }
        logger.warn(`[mcp:${serverName}] ${message}`)
      })

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
      // stderr 归日志：规范明确「不得假定 stderr 即出错」，故按 debug 转发而不升级为告警。
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim() !== '') logger.debug(`[mcp:${serverName}:stderr] ${line}`)
        }
      })
      child.stdin?.on('error', (err: Error) => {
        logger.debug(`[mcp:${serverName}] stdin 写入失败：${err.message}`)
      })

      child.once('exit', (code, signal) => {
        this.exited = true
        this.resolveExit?.()
        this.handlers.onExit({ code, signal, expected: this.closing })
      })
    })
  }

  /** 写一行 JSON-RPC；进程已退出/管道关闭时返回 false（调用方据此给出可读错误）。 */
  write(message: unknown): boolean {
    const stdin = this.child?.stdin
    if (!stdin || this.exited || this.closing) return false
    try {
      stdin.write(encodeMessage(message))
      return true
    } catch {
      return false
    }
  }

  /** 收尾：关 stdin → 等退出 → 超时强杀。幂等。 */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const child = this.child
    if (!child) return
    const shutdownGraceMs = this.opts.shutdownGraceMs ?? 2000
    const signalGraceMs = this.opts.signalGraceMs ?? 1500
    try {
      child.stdin?.end()
    } catch {
      /* stdin 可能已关闭 */
    }
    if (await this.waitExit(shutdownGraceMs)) return
    await this.terminate(signalGraceMs)
  }

  private onStdout(chunk: string): void {
    for (const line of this.lineBuffer.push(chunk)) {
      const parsed = parseLine(line)
      if (!parsed.ok) {
        // 服务端违反「stdout 只能是 MCP 消息」：告警并丢弃，绝不因此崩溃。
        this.opts.logger.warn(
          `[mcp:${this.opts.serverName}] 忽略了 stdout 上的非 MCP 内容（${parsed.reason}）：${line.slice(0, 120)}`,
        )
        continue
      }
      this.handlers.onMessage(parsed.message)
    }
    if (this.lineBuffer.overflowed && !this.warnedOverflow) {
      this.warnedOverflow = true
      this.opts.logger.warn(`[mcp:${this.opts.serverName}] stdout 出现超长未换行内容，已丢弃（帧格式违规）`)
    }
  }

  /** 强杀：Windows 走 `taskkill /T /F`（连带子进程）；POSIX 走 SIGTERM → SIGKILL。 */
  private async terminate(signalGraceMs: number): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      } catch {
        /* 进程可能已退出 */
      }
      if (await this.waitExit(signalGraceMs)) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
      await this.waitExit(signalGraceMs)
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      /* 进程可能已退出 */
    }
    if (await this.waitExit(signalGraceMs)) return
    try {
      child.kill('SIGKILL')
    } catch {
      /* 进程可能已退出 */
    }
    await this.waitExit(signalGraceMs)
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.exited) return true
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    await Promise.race([this.exitPromise, timeout])
    if (timer) clearTimeout(timer)
    return this.exited
  }
}
