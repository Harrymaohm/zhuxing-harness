import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvent, SessionMeta, SessionStore, SpaceMeta } from './index.js'

/**
 * 文件会话存储（JSONL 追加）：跨进程共享，支撑 `harness session` 会话管理。
 * 每会话一个 .jsonl 文件，事件逐行追加；元数据（标题/父子关系）写入 .meta.json，
 * 不污染 append-only 事件日志。
 */
export class FileSessionStore implements SessionStore {
  constructor(private dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`)
  }

  private metaFile(sessionId: string): string {
    return join(this.dir, `${sessionId}.meta.json`)
  }

  private spacesFile(): string {
    return join(this.dir, 'spaces.json')
  }

  private async readSpaces(): Promise<SpaceMeta[]> {
    try {
      const raw = await readFile(this.spacesFile(), 'utf-8')
      return JSON.parse(raw) as SpaceMeta[]
    } catch {
      return []
    }
  }

  private async writeSpaces(spaces: SpaceMeta[]): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.spacesFile(), `${JSON.stringify(spaces, null, 2)}\n`, 'utf-8')
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

  async getMeta(sessionId: string): Promise<SessionMeta | undefined> {
    try {
      const raw = await readFile(this.metaFile(sessionId), 'utf-8')
      return JSON.parse(raw) as SessionMeta
    } catch {
      return undefined
    }
  }

  async setMeta(meta: SessionMeta): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.metaFile(meta.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
  }

  async createSession(meta?: Partial<SessionMeta>): Promise<string> {
    const id = randomUUID()
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(id), '', 'utf-8')
    if (meta) {
      const now = Date.now()
      await this.setMeta({ id, parentId: meta.parentId, forkPointEventId: meta.forkPointEventId, title: meta.title, spaceId: meta.spaceId, createdAt: now, updatedAt: now })
    }
    return id
  }

  async forkSession(sourceId: string, forkPointEventId?: string): Promise<string> {
    const id = randomUUID()
    const events = await this.list(sourceId)
    let base = events
    if (forkPointEventId) {
      const idx = events.findIndex((e) => e.id === forkPointEventId)
      if (idx >= 0) base = events.slice(0, idx + 1)
    }
    const content = base.map((e) => JSON.stringify({ ...e, sessionId: id })).join('\n')
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file(id), content.length > 0 ? `${content}\n` : '', 'utf-8')
    const parentMeta = await this.getMeta(sourceId)
    const now = Date.now()
    await this.setMeta({
      id,
      parentId: sourceId,
      forkPointEventId,
      title: parentMeta?.title ? `${parentMeta.title}（分叉）` : undefined,
      createdAt: now,
      updatedAt: now,
    })
    return id
  }

  /** 把子会话事件回写进父会话（source 标记为 subsession），并追加合并结论。 */
  async mergeInto(parentId: string, childId: string, summary?: string): Promise<void> {
    const childEvents = await this.list(childId)
    const ts = Date.now()
    for (const evt of childEvents) {
      await this.append({
        id: randomUUID(),
        sessionId: parentId,
        ts,
        type: evt.type,
        source: 'subsession',
        payload: evt.payload,
      })
    }
    if (summary && summary.trim()) {
      await this.append({
        id: randomUUID(),
        sessionId: parentId,
        ts: ts + 1,
        type: 'assistant',
        source: 'subsession',
        payload: { content: summary, mergedFrom: childId },
      })
    }
    const parentMeta = await this.getMeta(parentId)
    if (parentMeta) {
      parentMeta.updatedAt = Date.now()
      await this.setMeta(parentMeta)
    }
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.file(sessionId), { force: true })
    await rm(this.metaFile(sessionId), { force: true })
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const existing = (await this.getMeta(sessionId)) ?? {
      id: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await this.setMeta({ ...existing, title, updatedAt: Date.now() })
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

  /** 会话清单 + 元数据（无 meta 文件时回退 undefined）。 */
  async listSessionsWithMeta(): Promise<Array<{ id: string; meta?: SessionMeta }>> {
    const ids = await this.listSessions()
    const out: Array<{ id: string; meta?: SessionMeta }> = []
    for (const id of ids) {
      out.push({ id, meta: await this.getMeta(id) })
    }
    return out
  }

  /** 软归档：标记 archived，移出主列表（数据保留，可恢复）。 */
  async archiveSession(sessionId: string): Promise<void> {
    const existing = (await this.getMeta(sessionId)) ?? {
      id: sessionId,
      createdAt: Date.now(),
    }
    await this.setMeta({ ...existing, archived: true, archivedAt: Date.now(), updatedAt: Date.now() })
  }

  /** 恢复归档：清除 archived 标记。 */
  async unarchiveSession(sessionId: string): Promise<void> {
    const existing = await this.getMeta(sessionId)
    if (!existing) return
    await this.setMeta({ ...existing, archived: false, archivedAt: undefined, updatedAt: Date.now() })
  }

  async createSpace(title: string): Promise<SpaceMeta> {
    const spaces = await this.readSpaces()
    const now = Date.now()
    const space: SpaceMeta = { id: randomUUID(), title: title.trim() || '未命名项目', createdAt: now, updatedAt: now }
    spaces.push(space)
    await this.writeSpaces(spaces)
    return space
  }

  async listSpaces(): Promise<SpaceMeta[]> {
    const spaces = await this.readSpaces()
    const sessions = await this.listSessionsWithMeta()
    return spaces.map((s) => ({
      ...s,
      sessionCount: sessions.filter((x) => x.meta?.spaceId === s.id).length,
    }))
  }

  async renameSpace(spaceId: string, title: string): Promise<void> {
    const spaces = await this.readSpaces()
    const target = spaces.find((s) => s.id === spaceId)
    if (!target) return
    target.title = title.trim() || '未命名项目'
    target.updatedAt = Date.now()
    await this.writeSpaces(spaces)
  }

  /** 删除空间及其下属全部会话（含归档）。 */
  async removeSpace(spaceId: string): Promise<void> {
    const spaces = await this.readSpaces()
    await this.writeSpaces(spaces.filter((s) => s.id !== spaceId))
    const sessions = await this.listSessionsWithMeta()
    for (const { id, meta } of sessions) {
      if (meta?.spaceId === spaceId) await this.remove(id)
    }
  }
}
