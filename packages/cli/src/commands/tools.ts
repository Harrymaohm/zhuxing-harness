import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { createHarness } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import { baseBundlePlugins } from '@zhuxing/harness-bundle'
import type { McpClientManager } from '@zhuxing/harness-bundle'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { loadConfig, loadDotEnv } from '../config-store.js'
import { out, outError } from '../output.js'
import { parseTokenPlanConfig } from './models.js'

/** 工具管理：list（列表）/ test（试运行）。 */
export async function cmdTools(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const cwd = process.cwd()
  loadDotEnv(cwd)
  const cfg = loadConfig()
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? cfg.apiKey
  const app = createHarness({ logLevel: 'warn' })
  try {
    for (const def of baseBundlePlugins({
      apiKey: apiKey ?? '',
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model ?? 'deepseek-v4-flash',
      workspace: resolve(cfg.workspace ?? cwd),
      level: (cfg.level ?? DEFAULT_PERMISSION_LEVEL) as PermissionLevel,
      tokenPlan: parseTokenPlanConfig(cfg),
      // 工具清单必须如实反映 MCP 工具，故带上配置并等待连接完成（一次性命令，值得多等几百毫秒）。
      mcpServers: cfg.mcpServers,
    })) {
      await app.mount(def)
    }
    await app.services.get<McpClientManager>('mcp')?.ready()
    const toolsRec = app.pluginManager.get('harness-tools')?.ctx.inject<ToolRegistry>('tools')
    if (!toolsRec) {
      outError('工具注册表未就绪')
      process.exitCode = 1
      return
    }
    switch (sub) {
      case 'list': {
        const tools = toolsRec.list()
        out(`已注册工具（${tools.length} 个）：`)
        for (const t of tools) {
          out(`  ${t.name.padEnd(20)} ${t.description.slice(0, 80)}`)
        }
        break
      }
      case 'test': {
        const { values, positionals } = parseArgs({
          options: {
            input: { type: 'string', short: 'i' },
            timeout: { type: 'string', short: 't' },
          },
          args: rest,
          allowPositionals: true,
        })
        const name = positionals[0]
        if (!name) {
          outError('用法：harness tools test <工具名> --input \'{"path":"..."}\'')
          process.exitCode = 2
          return
        }
        let inputArgs: Record<string, unknown> = {}
        if (values.input) {
          try {
            inputArgs = JSON.parse(values.input) as Record<string, unknown>
          } catch {
            outError('--input 必须是合法 JSON')
            process.exitCode = 2
            return
          }
        }
        const sandbox = app.pluginManager.get('harness-sandbox')?.ctx.inject<import('@zhuxing/harness-sandbox').Sandbox>('sandbox')
        const result = await toolsRec.execute(name, inputArgs, {
          sandbox,
          emit: (event, payload) => app.events.emit(event, payload),
        })
        out('结果：')
        out(JSON.stringify(result, null, 2))
        break
      }
      default:
        outError('用法：harness tools <list|test> [参数]')
        process.exitCode = 2
    }
  } finally {
    await app.dispose()
  }
}
