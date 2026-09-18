import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolvePlugins, loadPluginModule } from '@zhuxing/harness-config'
import { createHarness, HarnessError, maskSecrets } from '@zhuxing/harness-kernel'
import type { SessionService } from '@zhuxing/harness-session'
import type { AgentResult } from '@zhuxing/harness-agent'
import { foldResult } from '@zhuxing/harness-agent'
import { baseBundlePlugins } from '@zhuxing/harness-bundle'
import type { McpClientManager } from '@zhuxing/harness-bundle'
import type { ModelConfigEntry } from '@zhuxing/harness-model-router'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { loadConfig, loadDotEnv } from '../config-store.js'
import { attachProgress, fmt, out, outError } from '../output.js'
import { parseModelsConfig, parseImageModelConfig, parseTokenPlanConfig } from './models.js'

export async function cmdRun(args: string[]): Promise<void> {
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
      json: { type: 'boolean' },
      timing: { type: 'boolean' },
      verbose: { type: 'boolean' },
      stream: { type: 'boolean' },
      summary: { type: 'boolean' },
      'session-dir': { type: 'string' },
      models: { type: 'string' },
      'model-id': { type: 'string' },
      task: { type: 'string' },
    },
    allowPositionals: true,
  })

  const task = values.task ?? positionals.join(' ').trim()
  if (!task) {
    outError('错误：缺少任务描述。用法：harness run "任务描述"')
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
  const json = Boolean(values.json)
  const timing = Boolean(values.timing)
  const sessionDir =
    values['session-dir'] ?? process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
  const stream = Boolean(values.stream)

  const marks: Record<string, number> = { start: Date.now() }
  const app = createHarness({ logLevel: (values['log-level'] as never) ?? (json ? 'warn' : 'info') })
  attachProgress(app.events, json)

  // --stream：逐 token 渲染（非 json 时）
  let streamStarted = false
  const onToken = stream && !json ? (token: string) => {
    if (!streamStarted) {
      process.stdout.write(`${fmt.dim('▶')} `)
      streamStarted = true
    }
    process.stdout.write(token)
  } : undefined

  try {
    const { plugins } = await resolvePlugins({
      profile: values.profile,
      patches: values.patch,
      cwd,
    })
    marks.config = Date.now()

    // 1. 挂载基础 bundle（沙箱/会话/工具/模型/循环）
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
    marks.mounted = Date.now()

    // MCP 工具面就绪后再跑任务：插件挂载本身不阻塞（启动不阻断），但**任务**应当看到配置好的工具面，
    // 否则首次运行会因为 MCP 连接还在异步进行而看不到 mcp__* 工具。ready() 永不 reject（失败已隔离为告警）。
    await app.services.get<McpClientManager>('mcp')?.ready()

    // 2. 挂载配置解析出的第三方插件
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
    marks.plugins = Date.now()

    // 3. 运行任务
    const agentRecord = app.pluginManager.get('harness-agent')
    if (!agentRecord) {
      throw new HarnessError('Agent 循环未就绪（基础 bundle 挂载失败）', 'PLUGIN')
    }
    const agentSvc = agentRecord.ctx.inject<{
      run: (input: string, sessionId?: string, opts?: { onToken?: (t: string) => void }) => Promise<AgentResult>
    }>('agent')
    const result = await agentSvc.run(task, undefined, { onToken })
    marks.done = Date.now()
    if (streamStarted) process.stdout.write('\n')

    const timingReport = timing
      ? {
          totalMs: marks.done - marks.start,
          configParseMs: marks.config - marks.start,
          mountMs: marks.mounted - marks.config,
          pluginLoadMs: marks.plugins - marks.mounted,
          agentRunMs: marks.done - marks.plugins,
        }
      : undefined

    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          content: maskSecrets(result.content),
          steps: result.steps,
          finishedReason: result.finishedReason,
          sessionId: result.sessionId,
          timing: timingReport,
        }),
      )
    } else if (values.summary) {
      // 最终输出折叠：生成交付摘要；完整数据仍保留在会话日志
      const sessionService = app.pluginManager.get('harness-session')?.ctx.inject<SessionService>('sessionService')
      const events = sessionService ? await (await sessionService.get(result.sessionId)).events() : []
      const folded = foldResult(result, events)
      out(`【交付摘要】${folded.summary}${folded.summary.length < result.content.length ? '…' : ''}`)
      out(
        `（步骤 ${folded.steps} · ${folded.finishedReason} · 工具 ${folded.toolsUsed.map((t) => `${t.name}×${t.calls}`).join(', ') || '无'} · 会话 ${folded.sessionId.slice(0, 8)}）`,
      )
      out(`完整数据：harness session show ${folded.sessionId.slice(0, 8)}`)
    } else {
      out(fmt.cyan('\n===== 结果 ====='))
      out(result.content || fmt.dim('(无内容输出)'))
      out(fmt.dim(`\n（步骤数：${result.steps}，结束原因：${result.finishedReason}，会话：${result.sessionId}）`))
      if (timingReport) {
        out(`\n===== 耗时（ms）=====`)
        out(`  配置解析 ${timingReport.configParseMs} · 挂载 ${timingReport.mountMs} · 插件加载 ${timingReport.pluginLoadMs} · Agent 运行 ${timingReport.agentRunMs} · 总计 ${timingReport.totalMs}`)
      }
      if (values.verbose) {
        const sessionService = app.pluginManager.get('harness-session')?.ctx.inject<SessionService>('sessionService')
        if (sessionService) {
          const session = await sessionService.get(result.sessionId)
          const events = await session.events()
          out('\n===== 会话轨迹（replay）=====')
          for (const evt of events) {
            const payload = maskSecrets(JSON.stringify(evt.payload))
            out(`[${evt.type}] ${evt.source}: ${payload.slice(0, 180)}${payload.length > 180 ? '…' : ''}`)
          }
        }
      }
    }
  } finally {
    await app.dispose()
  }
}
