import { exec } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PluginDefinition } from '@zhuxing/harness-kernel'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { createSandbox } from '@zhuxing/harness-sandbox'
import type { SessionService } from '@zhuxing/harness-session'
import { DefaultSessionService, FileSessionStore, MemorySessionStore } from '@zhuxing/harness-session'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import type { ChatProvider } from '@zhuxing/harness-llm'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import type { AgentOptions } from '@zhuxing/harness-agent'

export interface BaseBundleOptions {
  apiKey: string
  baseUrl?: string
  model: string
  workspace: string
  level: PermissionLevel
  systemPrompt?: string
  maxSteps?: number
  temperature?: number
}

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
 * 基础 bundle：以插件形态提供沙箱、会话、工具、模型、Agent 循环。
 * 每一层都可被用户 patch 替换（无特权核心）。
 */
export function baseBundlePlugins(opts: BaseBundleOptions): PluginDefinition[] {
  const workspace = resolve(opts.workspace)

  return [
    {
      name: 'harness-sandbox',
      description: '权限策略分级沙箱',
      apply(ctx) {
        ctx.provide('sandbox', createSandbox({ level: opts.level, workspace }))
      },
    },
    {
      name: 'harness-session',
      description: '追加式会话事件日志（config.storeDir 指定时持久化为 JSONL）',
      apply(ctx) {
        const storeDir = ctx.config.storeDir as string | undefined
        const store = storeDir ? new FileSessionStore(storeDir) : new MemorySessionStore()
        ctx.provide('sessionStore', store)
        ctx.provide('sessionService', new DefaultSessionService(store))
      },
    },
    {
      name: 'harness-tools',
      description: '工具注册表（统一执行管道）',
      apply(ctx) {
        ctx.provide('tools', new ToolRegistryImpl())
      },
    },
    {
      name: 'harness-llm',
      description: 'OpenAI 兼容模型适配器（可用 config.provider 注入自定义实现）',
      apply(ctx) {
        const override = ctx.config.provider as ChatProvider | undefined
        ctx.provide(
          'llm',
          override ?? new OpenAICompatibleProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model }),
        )
      },
    },
    {
      name: 'harness-core-tools',
      description: '内建文件/命令工具',
      inject: ['tools'],
      apply(ctx) {
        const tools = ctx.inject<ToolRegistry>('tools')
        tools.register({
          name: 'shell',
          description: '在 workspace 中执行一条 shell 命令并返回输出',
          schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          sandbox: { commandArg: 'command' },
          execute: async (args) => runShell(String(args.command ?? ''), workspace),
        })
        tools.register({
          name: 'read_file',
          description: '读取指定文件内容',
          schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (args) => {
            try {
              const content = await readFile(resolve(workspace, String(args.path)), 'utf-8')
              return { text: content.slice(0, 50_000) }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
        tools.register({
          name: 'write_file',
          description: '写入文件内容（覆盖）',
          schema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
          sandbox: { writeArg: 'path' },
          execute: async (args) => {
            try {
              await writeFile(resolve(workspace, String(args.path)), String(args.content ?? ''), 'utf-8')
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
              const entries = await readdir(resolve(workspace, String(args.path)), { withFileTypes: true })
              return { text: entries.map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`).join('\n') }
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
      },
    },
    {
      name: 'harness-agent',
      description: 'Agent 循环（turn/step 编排）',
      inject: ['llm', 'tools', 'sessionService'],
      apply(ctx) {
        const llm = ctx.inject<ChatProvider>('llm')
        const tools = ctx.inject<ToolRegistry>('tools')
        const sessionService = ctx.inject<SessionService>('sessionService')
        const sandbox = ctx.injectOptional<import('@zhuxing/harness-sandbox').Sandbox>('sandbox')
        const options: AgentOptions = {
          systemPrompt: opts.systemPrompt,
          maxSteps: opts.maxSteps,
          temperature: opts.temperature,
        }
        ctx.provide('agent', {
          run: async (
            userInput: string,
            sessionId?: string,
            streamOpts?: { onToken?: (token: string) => void },
          ) => {
            const session = sessionId ? await sessionService.get(sessionId) : await sessionService.create()
            const { AgentLoop } = await import('@zhuxing/harness-agent')
            const loop = new AgentLoop(
              {
                llm,
                tools,
                session,
                sandbox,
                emit: (event, payload) => ctx.emit(event, payload),
                logger: ctx.logger,
              },
              { ...options, ...(streamOpts ?? {}) },
            )
            return loop.run(userInput)
          },
        })
      },
    },
  ]
}
