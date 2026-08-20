import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvent, SessionStore } from './index.js'

/**
 * 文件会话存储（JSONL 追加）：跨进程共享，支撑 `harness session` 会话管理。
 * 每会话一个 .jsonl 文件，事件逐行追加。
 */
export class FileSessionStore implements SessionStore {
  constructor(private dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`)
  }

  async append(evt: SessionEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.file(evt.sessionId), `${JSON.stringify(evt)}\n`, 'utf-8')
  }

  async list(sessionId: string): Promise<SessionEvent[]> {
    try {
      const content = await readFile(this.file(sessionId), 'utf-8')
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent)
    } catch {
      return []
    }
  }

  async createSession(): Promise<string> {
    const id = randomUUID()
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(id), '', 'utf-8')
    return id
  }

  async forkSession(sourceId: string): Promise<string> {
    const id = randomUUID()
    const events = await this.list(sourceId)
    const content = events.map((e) => JSON.stringify({ ...e, sessionId: id })).join('\n')
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(id), content.length > 0 ? `${content}\n` : '', 'utf-8')
    return id
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.file(sessionId), { force: true })
  }

  /** 列出全部会话 id（目录中 .jsonl 文件名）。 */
  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6))
    } catch {
      return []
    }
  }
}
