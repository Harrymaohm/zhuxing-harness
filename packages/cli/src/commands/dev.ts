import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolvePlugins, loadPluginModule } from '@zhuxing/harness-config'
import { createHarness, HarnessError } from '@zhuxing/harness-kernel'
import type { AgentResult } from '@zhuxing/harness-agent'
import { baseBundlePlugins } from '@zhuxing/harness-bundle'
import type { McpClientManager } from '@zhuxing/harness-bundle'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { loadConfig, loadDotEnv } from '../config-store.js'
import { attachProgress, fmt, out, outError } from '../output.js'
import { parseModelsConfig, parseImageModelConfig, parseTokenPlanConfig } from './models.js'

/** 文件内容哈希（用于 dev 变化检测）。 */
async function hashFile(path: string): Promise<string> {
  const content = await readFile(path, 'utf-8')
  return createHash('sha256').update(content).digest('hex')
}

export async function cmdDev(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      patch: { type: 'string', short: 'p', multiple: true },
      profile: { type: 'string' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      model: { type: 'string' },
      workspace: { type: 'string', short: 'w' },
      level: { type: 'string' },
      'max-steps': { type: 'string' },
      temperature: { type: 'string' },
      'system-prompt': { type: 'string' },
      'log-level': { type: 'string' },
      'session-dir': { type: 'string' },
      models: { type: 'string' },
      'model-id': { type: 'string' },
      task: { type: 'string' },
    },
    allowPositionals: true,
  })

  const task = values.task ?? positionals.join(' ').trim()
  if (!task) {
    outError('错误：dev 需要任务描述。用法：harness dev -p patch.yml "任务描述"')
    process.exitCode = 2
    return
  }
  const cwd = process.cwd()
  loadDotEnv(cwd)
  const cfg = loadConfig()
  const apiKey = values['api-key'] ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? cfg.apiKey
  if (!apiKey) {
    throw new HarnessError('缺少 API Key', 'AUTH', '请运行 harness login 配置，或通过 --api-key / DEEPSEEK_API_KEY 提供。')
  }
  const level = (values.level ?? cfg.level ?? DEFAULT_PERMISSION_LEVEL) as PermissionLevel
  const workspace = resolve(values.workspace ?? cfg.workspace ?? cwd)
  const sessionDir =
    values['session-dir'] ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')

  const app = createHarness({ logLevel: (values['log-level'] as never) ?? 'info' })
  attachProgress(app.events, false)

  const { plugins } = await resolvePlugins({ profile: values.profile, patches: values.patch, cwd })

  // 挂载基础 bundle
  for (const def of baseBundlePlugins({
    apiKey,
    baseUrl: values['base-url'] ?? cfg.baseUrl ?? 'https://api.deepseek.com/v1',
    model: values.model ?? cfg.model ?? 'deepseek-v4-flash',
    workspace,
    level,
    systemPrompt: values['system-prompt'],
    maxSteps: values['max-steps'] ? Number(values['max-steps']) : undefined,
    temperature: values.temperature ? Number(values.temperature) : undefined,
    models: values.models ? (JSON.parse(values.models) as ModelConfigEntry[]) : parseModelsConfig(cfg),
    modelId: values['model-id'],
    imageModel: parseImageModelConfig(cfg),
    tokenPlan: parseTokenPlanConfig(cfg),
    // MCP server 配置（stdio）：把外部 MCP 工具接入 agent（mcp__<server>__<tool>）。
    mcpServers: cfg.mcpServers,
  })) {
    const cfgOpt = def.name === 'harness-session' ? { storeDir: sessionDir } : undefined
    await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
  }

  const agentRecord = app.pluginManager.get('harness-agent')
  if (!agentRecord) throw new HarnessError('Agent 循环未就绪', 'PLUGIN')
  // MCP 工具面就绪后再跑任务（挂载本身不阻塞；ready() 永不 reject，失败已隔离为告警）。
  await app.services.get<McpClientManager>('mcp')?.ready()
  const agentSvc = agentRecord.ctx.inject<{ run: (input: string, sessionId?: string) => Promise<AgentResult> }>('agent')

  // 挂载 patch 配置的第三方插件
  for (const pc of plugins) {
    if (pc.enabled === false) continue
    const def = pc.inline ?? (pc.path ? await loadPluginModule(pc.path) : undefined)
    if (!def) {
      outError(`[cli] 插件 "${pc.id}" 缺少 path 或 inline，已跳过`)
      continue
    }
    try {
      await app.mount(def, { config: pc.config })
    } catch (err) {
      const he = HarnessError.from(err)
      outError(`[cli] 插件 "${pc.id}" 挂载失败：${he.message}${he.hint ? `（${he.hint}）` : ''}`)
    }
  }

  async function runTask(label: string): Promise<void> {
    out(`\n${fmt.bold(`===== ${label} =====`)}`)
    try {
      const result = await agentSvc.run(task)
      out('\n----- 结果 -----')
      out(result.content || '(无内容)')
      out(`（步骤 ${result.steps}，原因 ${result.finishedReason}）`)
    } catch (err) {
      const he = HarnessError.from(err)
      outError(`${fmt.red('✗')} 任务失败：${he.message}`)
    }
  }

  // 监听 patch 中插件入口文件的内容变化
  const watched = new Map<string, string>()
  for (const pc of plugins) {
    if (pc.path && pc.enabled !== false) {
      try {
        watched.set(pc.path, await hashFile(pc.path))
      } catch {
        /* 文件暂不可读，忽略 */
      }
    }
  }

  await runTask('首次运行')

  if (watched.size === 0) {
    out('\n（未监测到可监听插件：patch 中需配置 path 指向 .ts/.js 插件）')
  } else {
    out(`\n${fmt.dim('↻ 开发模式：监听 ' + [...watched.keys()].map((p) => basename(p)).join(', ') + '，修改文件将自动重载并重跑。Ctrl-C 退出。')}`)
  }

  const timer = setInterval(async () => {
    for (const [path, prevHash] of watched) {
      let hash: string
      try {
        hash = await hashFile(path)
      } catch {
        continue
      }
      if (hash !== prevHash) {
        watched.set(path, hash)
        const pc = plugins.find((p) => p.path === path)
        if (!pc) continue
        out(`${fmt.yellow('↻')} 检测到 ${basename(path)} 变化，重载插件 ${pc.id}…`)
        try {
          await app.unmount(pc.id)
          const mod = await loadPluginModule(path)
          await app.mount(mod, { config: pc.config })
          out(`${fmt.green('✓')} 插件 ${pc.id} 已重载`)
          await runTask('重跑任务')
        } catch (err) {
          const he = HarnessError.from(err)
          outError(`${fmt.red('✗')} 重载失败：${he.message}${he.hint ? `（${he.hint}）` : ''}`)
        }
      }
    }
  }, 500)

  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', () => {
      clearInterval(timer)
      resolveStop()
    })
  })

  out('\n正在退出…')
  await app.dispose()
}
