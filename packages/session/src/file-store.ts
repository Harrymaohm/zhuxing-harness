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

  /** spaces.json 的读-改-写串行化队列（理由见 serializeSpaces）。 */
  private spacesQueue: Promise<unknown> = Promise.resolve()

  /**
   * 把 spaces.json 的「读全量 → 改 → 写全量」串行化。
   *
   * createSpace / renameSpace / removeSpace 都是整文件读改写，无序列化时两个并发请求
   * （同一 Web 进程里同时到达两个 HTTP 请求很常见）会各自读到同一份旧快照、再互相覆盖，
   * 表现为「刚建的空间/刚改的名字莫名消失」。这里用一条 promise 链排队：
   * 进程内不再交叉，且落盘顺序与调用顺序一致。
   *
   * 跨进程（CLI 与 Web 同时改同一目录）仍无保护——那需要文件锁，超出当前实现范围。
   */
  private serializeSpaces<T>(fn: () => Promise<T>): Promise<T> {
    // 前一个任务无论成功失败都要继续排队（失败用自身兜底，避免一次写失败卡死整条队列）
    const next = this.spacesQueue.then(fn, fn)
    this.spacesQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 读一个 JSON 文件的容错语义（与 memory/file-store.ts 遵守同一契约）：
   * - 文件不存在 / 不可读 → undefined，这是正常的「还没有」
   * - 内容不是合法 JSON → **备份原文件 + 告警**后返回 undefined
   *
   * 为什么不能像以前那样静默返回空：元数据与空间清单都是「读全量 → 改 → 写全量」，
   * 一次解析失败被吞掉，下一次写入就会把损坏内容永久覆盖。用户视角是「标题/归属/空间
   * 凭空消失」且毫无线索；备份至少留下人工恢复的可能。
   */
  private async readJsonTolerant<T>(file: string, what: string): Promise<T | undefined> {
    let raw: string
    try {
      // 去掉 UTF-8 BOM：记事本等编辑器保存的 JSON 常带 BOM，会让 JSON.parse 直接抛错
      raw = (await readFile(file, 'utf-8')).replace(/^\uFEFF/, '').trim()
    } catch {
      return undefined
    }
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as T
    } catch (err) {
      // 固定文件名而不是带时间戳：损坏文件在无人修复前会被反复读取（listSpaces 每次都会读），
      // 带时间戳会在每次读取时新落一个备份、无界增长。固定名让备份有界（只保留最新一份原始内容），
      // 而内容本来就来自同一个未被改动的坏文件，覆盖它不会丢失任何信息。
      const backup = `${file}.corrupt`
      try {
        await writeFile(backup, raw, 'utf-8')
      } catch {
        // 备份失败不阻断主流程，告警里仍带上原路径
      }
      console.warn(
        `[harness] ${what}解析失败，已按空值继续（原文件备份至 ${backup}）：${file} —— ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  private async readSpaces(): Promise<SpaceMeta[]> {
    return (await this.readJsonTolerant<SpaceMeta[]>(this.spacesFile(), '空间清单')) ?? []
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
    let content: string
    try {
      content = await readFile(this.file(sessionId), 'utf-8')
    } catch {
      // 文件不存在：还没有任何事件，属正常状态
      return []
    }
    // 逐行解析：JSONL 的价值就在于「坏行只坏一行」——此前一处解析失败会让整个会话
    // 在界面上凭空消失（返回空数组），而且没有任何痕迹。现在坏行单独跳过并计数告警，
    // 其余历史照常可读。
    const events: SessionEvent[] = []
    let broken = 0
    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch {
        broken += 1
      }
    }
    if (broken > 0) {
      console.warn(
        `[harness] 会话 ${sessionId} 有 ${broken} 行事件无法解析，已跳过（其余 ${events.length} 条正常读取）：${this.file(sessionId)}`,
      )
    }
    return events
  }

  async getMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.readJsonTolerant<SessionMeta>(this.metaFile(sessionId), '会话元数据')
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
    return this.serializeSpaces(async () => {
      const spaces = await this.readSpaces()
      const now = Date.now()
      const space: SpaceMeta = { id: randomUUID(), title: title.trim() || '未命名项目', createdAt: now, updatedAt: now }
      spaces.push(space)
      await this.writeSpaces(spaces)
      return space
    })
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
    await this.serializeSpaces(async () => {
      const spaces = await this.readSpaces()
      const target = spaces.find((s) => s.id === spaceId)
      if (!target) return
      target.title = title.trim() || '未命名项目'
      target.updatedAt = Date.now()
      await this.writeSpaces(spaces)
    })
  }

  /** 删除空间及其下属全部会话（含归档）。 */
  async removeSpace(spaceId: string): Promise<void> {
    await this.serializeSpaces(async () => {
      const spaces = await this.readSpaces()
      await this.writeSpaces(spaces.filter((s) => s.id !== spaceId))
    })
    const sessions = await this.listSessionsWithMeta()
    for (const { id, meta } of sessions) {
      if (meta?.spaceId === spaceId) await this.remove(id)
    }
  }
}
