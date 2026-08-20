import { maskSecrets } from '@zhuxing/harness-kernel'
import type { EventBus } from '@zhuxing/harness-kernel'
import type { ToolResult } from '@zhuxing/harness-tools'

const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/** 终端是否支持颜色（非 TTY 时关闭，保证管道输出纯净）。 */
const useColor = typeof process.stdout.isTTY === 'boolean' ? process.stdout.isTTY : false

function paint(code: string, text: string): string {
  return useColor ? `${code}${text}${RESET}` : text
}

export const fmt = {
  cyan: (s: string) => paint(CYAN, s),
  green: (s: string) => paint(GREEN, s),
  yellow: (s: string) => paint(YELLOW, s),
  red: (s: string) => paint(RED, s),
  dim: (s: string) => paint(DIM, s),
  bold: (s: string) => paint(BOLD, s),
}

/** 输出前统一脱敏，防凭证泄漏。 */
export function out(text: string): void {
  console.log(maskSecrets(text))
}

export function outError(text: string): void {
  console.error(maskSecrets(text))
}

function summarizeArgs(args: Record<string, unknown>, max = 50): string {
  try {
    const s = JSON.stringify(args) ?? ''
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return ''
  }
}

function resultText(result: ToolResult, max = 70): string {
  if (result.error !== undefined) return `错误: ${result.error.slice(0, max)}`
  if (result.text !== undefined) return result.text.replace(/\s+/g, ' ').trim().slice(0, max)
  if (result.json !== undefined) {
    const s = JSON.stringify(result.json) ?? ''
    return s.length > max ? `${s.slice(0, max)}…` : s
  }
  return ''
}

/**
 * 订阅 agent/tools 事件，实时输出执行进度（消除"卡死感"）。
 * quiet=true 时静默（用于 --json）。
 */
export function attachProgress(events: EventBus, quiet: boolean): void {
  if (quiet) return
  events.on(
    'agent/pre-step',
    (p: { step: number }) => {
      console.log(`${fmt.cyan('▶')} 第 ${(p.step as number) + 1} 步：调用模型…`)
    },
    'cli',
  )
  events.on(
    'tools/before-exec',
    (p: { name: string; args: Record<string, unknown> }) => {
      console.log(`  ${fmt.dim('↳')} 工具 ${fmt.yellow(maskSecrets(p.name))}(${maskSecrets(summarizeArgs(p.args))})…`)
    },
    'cli',
  )
  events.on(
    'tools/after-exec',
    (p: { name: string; result: ToolResult }) => {
      const text = resultText(p.result)
      const line = text.length > 0 ? ` → ${maskSecrets(text)}` : ''
      console.log(`  ${fmt.green('✓')} ${maskSecrets(p.name)}${line}`)
    },
    'cli',
  )
  events.on(
    'agent/post-step',
    (p: { done: boolean }) => {
      if (p.done) console.log(`${fmt.green('✓')} 步骤完成`)
    },
    'cli',
  )
}
