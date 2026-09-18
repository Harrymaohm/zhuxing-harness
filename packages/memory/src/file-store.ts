import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryEntry, MemoryFilter, MemoryScope, MemoryStore } from './types.js'

/** 默认存储路径：~/.zhuxing-harness/memories.json */
export function defaultMemoryPath(): string {
  return process.env.HARNESS_MEMORY_PATH ?? join(homedir(), '.zhuxing-harness', 'memories.json')
}

/** 生成短 ID。 */
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** JSON 文件记忆存储（权限 600，与 config.json 对齐）。 */
export class FileMemoryStore implements MemoryStore {
  constructor(private readonly path: string = defaultMemoryPath()) {}

  private readAll(): MemoryEntry[] {
    let raw: string
    try {
      // 去掉 UTF-8 BOM：记事本等编辑器保存的 JSON 常带 BOM，会让 JSON.parse 直接抛错，
      // 若不处理就会被下面的损坏分支误判成「文件坏了」。
      raw = readFileSync(this.path, 'utf-8').replace(/^\uFEFF/, '').trim()
    } catch {
      // 文件不存在或不可读：属于「还没有记忆」的正常状态
      return []
    }
    if (!raw) return []
    try {
      const data = JSON.parse(raw)
      return Array.isArray(data) ? (data as MemoryEntry[]) : []
    } catch (err) {
      // 文件存在但解析失败：不能静默返回空数组——下一次写入就会把损坏内容永久覆盖，
      // 用户视角是「记忆凭空消失」且毫无线索。先备份原文件再告警，保留人工恢复的可能。
      // 固定文件名而不是带时间戳：损坏文件在无人修复前会被反复读取（list 每次都会读），
      // 带时间戳会在每次读取时新落一个备份、无界增长。固定名让备份有界（只保留最新一份原始内容），
      // 而内容本来就来自同一个未被改动的坏文件，覆盖它不会丢失任何信息。
      const backup = `${this.path}.corrupt`
      try {
        writeFileSync(backup, raw, { encoding: 'utf-8', mode: 0o600 })
      } catch {
        // 备份失败不阻断主流程，告警里仍带上原路径
      }
      console.warn(
        `[harness] 记忆文件解析失败，已按空记忆继续（原文件备份至 ${backup}）：${this.path} —— ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }

  private writeAll(entries: MemoryEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(entries, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    let entries = this.readAll()
    if (!filter) return entries
    if (filter.scope) entries = entries.filter((e) => e.scope === filter.scope)
    if (filter.sessionId) entries = entries.filter((e) => e.sessionId === filter.sessionId)
    if (filter.workspace) entries = entries.filter((e) => !e.workspace || e.workspace === filter.workspace)
    if (filter.tags?.length) {
      entries = entries.filter((e) => {
        const tags = e.tags ?? []
        return filter.tags!.some((t) => tags.includes(t))
      })
    }
    if (filter.q) {
      const q = filter.q.toLowerCase()
      entries = entries.filter(
        (e) => e.content.toLowerCase().includes(q) || (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      )
    }
    return entries
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.readAll().find((e) => e.id === id)
  }

  async add(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    const now = Date.now()
    const entry: MemoryEntry = { ...input, id: genId(), createdAt: now, updatedAt: now }
    const entries = this.readAll()
    entries.push(entry)
    this.writeAll(entries)
    return entry
  }

  async update(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry | undefined> {
    const entries = this.readAll()
    const idx = entries.findIndex((e) => e.id === id)
    if (idx < 0) return undefined
    entries[idx] = { ...entries[idx], ...patch, updatedAt: Date.now() }
    this.writeAll(entries)
    return entries[idx]
  }

  async remove(id: string): Promise<boolean> {
    const entries = this.readAll()
    const before = entries.length
    const filtered = entries.filter((e) => e.id !== id)
    if (filtered.length === before) return false
    this.writeAll(filtered)
    return true
  }

  async clear(scope?: MemoryScope): Promise<number> {
    const entries = this.readAll()
    if (!scope) {
      this.writeAll([])
      return entries.length
    }
    const filtered = entries.filter((e) => e.scope !== scope)
    this.writeAll(filtered)
    return entries.length - filtered.length
  }
}
