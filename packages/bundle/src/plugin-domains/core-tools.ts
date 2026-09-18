/** 内建文件 / 命令工具插件：shell、read_file、write_file、list_dir、search_files。 */
import { exec } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import { isSensitiveReadPath } from '@zhuxing/harness-sandbox'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { BaseBundleOptions } from '../options.js'
import { TREE_IGNORE } from '../workspace-profile.js'

/** shell 执行（Promise 化）。 */
function runShell(command: string, cwd: string): Promise<{ text: string }> {
  return new Promise((resolveResult) => {
    exec(command, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parts: string[] = []
      if (stdout.trim()) parts.push(stdout.trimEnd())
      if (stderr.trim()) parts.push(`[stderr] ${stderr.trimEnd()}`)
      if (err) parts.push(`[exit ${(err as NodeJS.ErrnoException & { code?: number | string }).code ?? 'error'}]`)
      resolveResult({ text: parts.length > 0 ? parts.join('\n') : '(无输出)' })
    })
  })
}

/**
 * @param deps.workspace 已 resolve 的绝对工作区路径（工具相对路径的基准）
 */
export function coreToolsPlugins(deps: Pick<BaseBundleOptions, 'workspace'>): PluginDefinition[] {
  return [
    {
      name: 'harness-core-tools',
      description: '内建文件/命令工具',
      inject: ['tools'],
      apply(ctx) {
        const tools = ctx.inject<ToolRegistry>('tools')
        tools.register({
          name: 'shell',
          description: `在 workspace 中执行一条 ${process.platform === 'win32' ? 'cmd.exe' : 'sh'} 命令并返回输出（文件/目录的读、写、列举请优先用 read_file/write_file/list_dir）${process.platform === 'win32' ? '；Windows 下用 PowerShell 读文本文件要加 -Encoding UTF8（或改用 read_file），否则中文会乱码' : ''}`,
          schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          sandbox: { commandArg: 'command' },
          execute: async (args) => runShell(String(args.command ?? ''), deps.workspace),
        })
        tools.register({
          name: 'read_file',
          description: '读取指定文件内容',
          schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          // 读侧权限模型入口：沙箱会对 path 做凭据类文件裁决（与沙箱等级无关，任意等级都拒绝读 .env / 私钥）
          sandbox: { readArg: 'path' },
          execute: async (args) => {
            try {
              const target = resolve(deps.workspace, String(args.path))
              // 防御性二次过滤：即便调用方未注入 sandbox（如自定义装配），凭据类文件也不经工具读取
              if (isSensitiveReadPath(target)) return { error: '拒绝读取凭据类文件（.env / 私钥 / secrets.*）' }
              const content = await readFile(target, 'utf-8')
              return { text: content.slice(0, 50_000) }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'write_file',
          description: '写入文件内容（覆盖；父目录不存在时自动创建，无需先 mkdir）',
          schema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
          sandbox: { writeArg: 'path' },
          execute: async (args) => {
            try {
              const target = resolve(deps.workspace, String(args.path))
              // 自动补建父目录：向新目录写文件是最常见动作，缺目录时直接建，避免模型多跑一轮 mkdir
              await mkdir(dirname(target), { recursive: true })
              await writeFile(target, String(args.content ?? ''), 'utf-8')
              return { text: `已写入 ${args.path}` }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'list_dir',
          description: '列出目录内容',
          schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (args) => {
            try {
              const entries = await readdir(resolve(deps.workspace, String(args.path)), { withFileTypes: true })
              return { text: entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n') }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'search_files',
          description:
            '递归跨文件搜索文本或正则，返回「路径:行号:行内容」。默认搜整个工作区，用 path 可指向任意绝对路径（含工作区外的本体源码仓）。行号即文件真实行号（UTF-8 按行计），可直接引用，无需再用 shell 复核；' +
            '要定位某函数/选项/配置出现在哪些文件与行时首选此工具（勿用 findstr/Select-String 硬凑——它们对中文与 UTF-8 无 BOM 文件会静默漏匹配，也勿写临时脚本扫描）',
          schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '要查找的文本或正则表达式（如 "verifyGoal"、"export function .*Goal"）' },
              path: { type: 'string', description: '搜索起始目录（相对 workspace 或绝对路径，可指向工作区外目录，默认整个工作区）' },
              ext: { type: 'string', description: '只搜该后缀的文件，如 ".ts"（可选，可显著减少噪音）' },
              maxResults: { type: 'number', description: '最多返回的匹配行数（默认 80，上限 400）' },
            },
            required: ['pattern'],
          },
          execute: async (args) => {
            try {
              const raw = String(args.pattern ?? '')
              if (!raw) return { error: 'pattern 不能为空' }
              // 优先按正则解释；不是合法正则时退化为字面量匹配，避免模型给出含 () 的普通文本时报错
              let re: RegExp
              try {
                re = new RegExp(raw)
              } catch {
                re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              }
              const ext = args.ext ? String(args.ext) : ''
              const limit = Math.min(Number(args.maxResults) > 0 ? Number(args.maxResults) : 80, 400)
              const root = resolve(deps.workspace, String(args.path ?? '.'))
              const hits: string[] = []
              const maxFiles = 4000
              let scanned = 0

              const walk = async (dir: string, depth: number): Promise<void> => {
                if (hits.length >= limit || depth > 8 || scanned > maxFiles) return
                const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
                for (const e of entries) {
                  if (hits.length >= limit || scanned > maxFiles) return
                  const full = join(dir, e.name)
                  if (e.isDirectory()) {
                    if (TREE_IGNORE.has(e.name.toLowerCase())) continue
                    await walk(full, depth + 1)
                    continue
                  }
                  if (ext && !e.name.endsWith(ext)) continue
                  // 凭据类文件不进入搜索结果：本工具会把文件内容读出来，若只对 path 参数裁决，
                  // 目录内的 .env / 私钥仍会被读出。逐文件过滤才是读侧权限模型的完整闭环。
                  if (isSensitiveReadPath(full)) continue
                  scanned += 1
                  let text: string
                  try {
                    text = await readFile(full, 'utf-8')
                  } catch {
                    continue
                  }
                  // 二进制/超大文件跳过：含 NUL 字节视为二进制，超过 1MB 直接不看
                  if (text.length > 1_000_000 || text.includes('\u0000')) continue
                  const lines = text.split('\n')
                  for (let i = 0; i < lines.length; i++) {
                    if (!re.test(lines[i])) continue
                    const shown = lines[i].trim().slice(0, 200)
                    // 命中在工作区外（如本体源码仓）时给绝对路径：`..\..\` 形式的相对路径无法直接复用
                    const rel = relative(deps.workspace, full)
                    hits.push(`${rel && !rel.startsWith('..') ? rel : full}:${i + 1}:${shown}`)
                    if (hits.length >= limit) break
                  }
                }
              }
              await walk(root, 0)
              if (hits.length === 0) return { text: `未找到匹配「${raw}」的内容` }
              const more = hits.length >= limit ? `\n（已截断：仅显示前 ${limit} 条匹配，可加 ext 或 path 缩小范围）` : ''
              return { text: hits.join('\n') + more }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
      },
    },
  ]
}
