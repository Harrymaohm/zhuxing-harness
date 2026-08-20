import type { Logger } from './types.js'

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]

/** 轻量结构化 Logger。 */
export class ConsoleLogger implements Logger {
  private levelIndex: number

  constructor(
    private prefix: string,
    level: LogLevel = 'info',
  ) {
    this.levelIndex = LEVELS.indexOf(level)
  }

  trace(msg: string, ...args: unknown[]): void {
    this.log('trace', msg, args)
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, args)
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, args)
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, args)
  }

  error(msg: string, ...args: unknown[]): void {
    this.log('error', msg, args)
  }

  private log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVELS.indexOf(level) < this.levelIndex) return
    const time = new Date().toISOString()
    const line = `[${time}] [${level.toUpperCase()}] ${this.prefix ? `[${this.prefix}] ` : ''}${msg}`
    if (level === 'error') {
      console.error(line, ...args)
    } else if (level === 'warn') {
      console.warn(line, ...args)
    } else {
      console.log(line, ...args)
    }
  }
}

export function createLogger(prefix = '', level: LogLevel = 'info'): Logger {
  return new ConsoleLogger(prefix, level)
}
