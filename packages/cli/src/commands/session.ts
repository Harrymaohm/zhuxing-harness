import { homedir } from 'node:os'
import { join } from 'node:path'
import { maskSecrets } from '@zhuxing/harness-kernel'
import { FileSessionStore } from '@zhuxing/harness-session'
import { out, outError } from '../output.js'

/** 解析会话 id：支持完整 id 或唯一前缀。 */
async function resolveSessionId(store: FileSessionStore, partial: string): Promise<string | null> {
  const ids = await store.listSessions()
  if (ids.includes(partial)) return partial
  const matches = ids.filter((i) => i.startsWith(partial))
  return matches.length === 1 ? matches[0] : null
}

export async function cmdSession(args: string[]): Promise<void> {
  const [sub, id] = args
  const dir = process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
  const store = new FileSessionStore(dir)
  switch (sub) {
    case 'ls': {
      const ids = await store.listSessions()
      if (ids.length === 0) {
        out('（无会话。运行 harness run 后会生成）')
        return
      }
      out(`会话目录：${dir}`)
      for (const sid of ids) {
        const events = await store.list(sid)
        const first = events[0]
        const meta = await store.getMeta(sid)
        const time = first ? new Date(first.ts).toISOString().replace('T', ' ').slice(0, 19) : '-'
        const archived = meta?.archived ? '  [归档]' : ''
        const space = meta?.spaceId ? `  @${meta.spaceId.slice(0, 8)}` : ''
        const title = meta?.title ? `  ${meta.title}` : ''
        out(`  ${sid.slice(0, 8)}  ${String(events.length).padStart(4)} 事件  ${time}${archived}${space}${title}`)
      }
      break
    }
    case 'archive': {
      if (!id) {
        outError('用法：harness session archive <会话id或前缀>')
        process.exitCode = 2
        return
      }
      const fullId = (await resolveSessionId(store, id)) ?? id
      await store.archiveSession(fullId)
      out(`✓ 已归档会话 ${fullId}`)
      break
    }
    case 'unarchive': {
      if (!id) {
        outError('用法：harness session unarchive <会话id或前缀>')
        process.exitCode = 2
        return
      }
      const fullId = (await resolveSessionId(store, id)) ?? id
      await store.unarchiveSession(fullId)
      out(`✓ 已恢复会话 ${fullId}`)
      break
    }
    case 'show': {
      if (!id) {
        outError('用法：harness session show <会话id或前缀>')
        process.exitCode = 2
        return
      }
      const fullId = (await resolveSessionId(store, id)) ?? id
      const events = await store.list(fullId)
      if (events.length === 0) {
        out(`（会话 ${fullId} 无记录）`)
        return
      }
      for (const evt of events) {
        const payload = maskSecrets(JSON.stringify(evt.payload))
        out(
          `[${new Date(evt.ts).toISOString().slice(11, 19)}] ${evt.type.padEnd(9)} ${evt.source}: ${payload.slice(0, 200)}${payload.length > 200 ? '…' : ''}`,
        )
      }
      break
    }
    case 'rm': {
      if (!id) {
        outError('用法：harness session rm <会话id或前缀>')
        process.exitCode = 2
        return
      }
      const fullId = (await resolveSessionId(store, id)) ?? id
      await store.remove(fullId)
      out(`✓ 已删除会话 ${fullId}`)
      break
    }
    default:
      outError('用法：harness session <ls | show | rm | archive | unarchive> [会话id]')
      process.exitCode = 2
  }
}

/** 空间（项目）管理：ls / add / rename / rm。 */
export async function cmdSpace(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const dir = process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
  const store = new FileSessionStore(dir)
  switch (sub) {
    case 'ls': {
      const spaces = await store.listSpaces()
      if (spaces.length === 0) {
        out('（无空间。运行 harness space add <名称> 创建）')
        return
      }
      out(`空间目录：${dir}`)
      for (const s of spaces) {
        out(`  ${s.id.slice(0, 8)}  ${String(s.sessionCount ?? 0).padStart(3)} 会话  ${s.title}`)
      }
      break
    }
    case 'add': {
      const title = rest.join(' ').trim()
      if (!title) {
        outError('用法：harness space add <名称>')
        process.exitCode = 2
        return
      }
      const space = await store.createSpace(title)
      out(`✓ 已创建空间 ${space.id}（${space.title}）`)
      break
    }
    case 'rename': {
      const [id, ...nameRest] = rest
      const title = nameRest.join(' ').trim()
      if (!id || !title) {
        outError('用法：harness space rename <空间id或前缀> <名称>')
        process.exitCode = 2
        return
      }
      const spaces = await store.listSpaces()
      const space = spaces.find((s) => s.id.startsWith(id))
      if (!space) {
        outError(`未找到空间 ${id}`)
        process.exitCode = 1
        return
      }
      await store.renameSpace(space.id, title)
      out(`✓ 已重命名空间 ${space.id}`)
      break
    }
    case 'rm': {
      const id = rest[0]
      if (!id) {
        outError('用法：harness space rm <空间id或前缀>（删除空间及其全部会话）')
        process.exitCode = 2
        return
      }
      const spaces = await store.listSpaces()
      const space = spaces.find((s) => s.id.startsWith(id))
      if (!space) {
        outError(`未找到空间 ${id}`)
        process.exitCode = 1
        return
      }
      await store.removeSpace(space.id)
      out(`✓ 已删除空间 ${space.id} 及其会话`)
      break
    }
    default:
      outError('用法：harness space <ls | add | rename | rm>')
      process.exitCode = 2
  }
}
