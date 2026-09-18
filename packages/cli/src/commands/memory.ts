import { parseArgs } from 'node:util'
import { FileMemoryStore, defaultMemoryPath } from '@zhuxing/harness-memory'
import type { MemoryScope } from '@zhuxing/harness-memory'
import { out, outError } from '../output.js'

/** 跨会话记忆管理：list / add / rm / clear。 */
export async function cmdMemory(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const store = new FileMemoryStore(defaultMemoryPath())
  switch (sub) {
    case 'list': {
      const { values } = parseArgs({
        options: {
          scope: { type: 'string', short: 's' },
          q: { type: 'string' },
        },
        args: rest,
        allowPositionals: false,
      })
      const entries = await store.list({
        scope: values.scope as MemoryScope | undefined,
        q: values.q,
      })
      if (entries.length === 0) {
        out('（无记忆。AI 运行时调用 remember 工具或 harness memory add 添加）')
        return
      }
      out(`记忆文件：${defaultMemoryPath()}`)
      for (const e of entries) {
        const tags = e.tags?.length ? ` {${e.tags.join(',')}}` : ''
        const ws = e.workspace ? ` @${e.workspace}` : ''
        out(`  ${e.id.slice(-6)}  [${e.scope}]${tags}${ws}  ${e.content}`)
      }
      break
    }
    case 'add': {
      const { values, positionals } = parseArgs({
        options: {
          scope: { type: 'string', short: 's' },
          tags: { type: 'string', short: 't' },
          workspace: { type: 'string', short: 'w' },
        },
        args: rest,
        allowPositionals: true,
      })
      const content = positionals.join(' ').trim()
      if (!content) {
        outError('用法：harness memory add "记忆内容" [--scope user|project|auto] [--tags a,b] [--workspace 路径]')
        process.exitCode = 2
        return
      }
      const scope = (values.scope as MemoryScope) ?? 'auto'
      const entry = await store.add({
        scope,
        content,
        tags: typeof values.tags === 'string' ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        workspace: typeof values.workspace === 'string' ? values.workspace : undefined,
      })
      out(`✓ 已记忆 [${entry.scope}]：${content}（id: ${entry.id}）`)
      break
    }
    case 'rm': {
      const id = rest[0]
      if (!id) {
        outError('用法：harness memory rm <id>')
        process.exitCode = 2
        return
      }
      // 支持短 id 后缀匹配
      const all = await store.list()
      const match = all.filter((e) => e.id.endsWith(id))
      if (match.length === 0) {
        outError(`未找到记忆 id: ${id}`)
        process.exitCode = 1
        return
      }
      if (match.length > 1) {
        outError(`id 前缀匹配多条记忆，请提供更完整的 id`)
        process.exitCode = 1
        return
      }
      await store.remove(match[0].id)
      out(`✓ 已删除记忆 ${match[0].id}`)
      break
    }
    case 'clear': {
      const { values } = parseArgs({
        options: { scope: { type: 'string', short: 's' } },
        args: rest,
        allowPositionals: false,
      })
      const scope = values.scope as MemoryScope | undefined
      const n = await store.clear(scope)
      out(`✓ 已清空 ${n} 条${scope ? `[${scope}]` : ''}记忆`)
      break
    }
    default:
      outError('用法：harness memory <list|add|rm|clear> [参数]')
      process.exitCode = 2
  }
}
