#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolvePlugins, loadPluginModule } from '@zhuxing/harness-config'
import { createHarness, normalizePlugin, HarnessError, maskSecrets } from '@zhuxing/harness-kernel'
import type { SessionService } from '@zhuxing/harness-session'
import { FileSessionStore } from '@zhuxing/harness-session'
import type { AgentResult } from '@zhuxing/harness-agent'
import { foldResult } from '@zhuxing/harness-agent'
import { baseBundlePlugins } from '@zhuxing/harness-bundle'
import { loadConfig, saveConfig, loadDotEnv, configPath } from './config-store.js'
import type { HarnessConfig } from './config-store.js'
import { attachProgress, fmt, out, outError } from './output.js'

/** 包版本：优先使用构建注入（bundle 时 define），否则读取本包 package.json。 */
function packageVersion(): string {
  const injected = (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__
  if (injected) return injected
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = packageVersion()

const HELP = `筑星 Harness CLI

用法：
  harness run [选项] "任务描述"      运行一次 Agent 任务（实时显示进度）
  harness dev [选项] "任务描述"      开发模式：监听插件变化，自动重载并重跑
  harness login                    交互式配置 API Key / 模型 / 工作区（持久化）
  harness config <get|set|list|rm> 查看/修改持久化配置
  harness session <ls|show|rm>     会话管理（基于 ~/.zhuxing-harness/sessions）
  harness validate <插件路径>       校验插件定义
  harness create-plugin <名称>      生成插件脚手架
  harness install <插件目录> [--as <名称>]  安装本地插件到 plugins/
  harness list [选项]              列出配置解析出的插件
  harness web [--port <n>]        启动 Web UI（对话/工作/交付，默认端口 3080）
  harness doctor [--network]       环境自检（版本/配置/目录/端点）
  harness completion [bash|zsh]    生成 shell 补全脚本
  harness version / -v             显示版本
  harness help                     显示帮助

run / dev 选项：
  -p, --patch <文件>        patch 覆盖层（可多次）
      --profile <文件>      profile 组合文件
      --api-key <key>       API Key（默认：配置 / 环境变量）
      --base-url <url>      OpenAI 兼容端点（默认 https://api.deepseek.com/v1）
      --model <name>        模型名（默认 deepseek-v4-flash）
  -w, --workspace <目录>    工作区（默认：配置或当前目录）
      --level <级别>        沙箱级别：read-only | workspace-write | danger-full-access（默认 danger-full-access）
      --max-steps <n>       Agent 最大步数（默认 20）
      --temperature <t>     采样温度
      --system-prompt <s>   系统提示
      --session-dir <目录>  会话持久化目录（默认 ~/.zhuxing-harness/sessions）
      --stream              逐 token 流式输出模型回答
      --json                输出结构化 JSON（用于脚本）
      --summary             最终输出折叠为交付摘要（完整数据在会话日志）
      --timing              打印各阶段耗时
      --verbose             打印完整会话轨迹
      --log-level <l>       日志级别：trace|debug|info|warn|error

示例：
  harness run "总结这个仓库的包结构"
  harness run --stream "解释一下什么是 Agent harness"
  harness dev -p my-plugin.yml "执行插件提供的工具"
  harness session ls
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.log(HELP)
    return
  }
  const [command, ...rest] = argv
  switch (command) {
    case 'run':
      await cmdRun(rest)
      break
    case 'validate':
      await cmdValidate(rest)
      break
    case 'create-plugin':
      await cmdCreatePlugin(rest)
      break
    case 'install':
      await cmdInstall(rest)
      break
    case 'list':
      await cmdList(rest)
      break
    case 'login':
      await cmdLogin()
      break
    case 'config':
      await cmdConfig(rest)
      break
    case 'session':
      await cmdSession(rest)
      break
    case 'dev':
      await cmdDev(rest)
      break
    case 'completion':
      await cmdCompletion(rest)
      break
    case 'doctor':
      await cmdDoctor(rest)
      break
    case 'web':
      await cmdWeb(rest)
      break
    case 'version':
    case '-v':
    case '--version':
      out(`zhuxing-harness v${VERSION}`)
      break
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      break
    default:
      outError(`未知命令：${command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}

async function cmdLogin(): Promise<void> {
  const existing = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const apiKey = (await rl.question(fmt.bold('DeepSeek API Key：'))).trim()
    if (!apiKey) {
      outError('✗ API Key 不能为空')
      process.exitCode = 2
      return
    }
    const baseUrl = (await rl.question(`Base URL [${'https://api.deepseek.com/v1'}]：`)).trim()
    const model = (await rl.question(`模型 [${'deepseek-v4-flash'}]：`)).trim()
    const workspace = (await rl.question(`工作区 [${process.cwd()}]：`)).trim()
    const levelRaw = (await rl.question(`沙箱级别 [danger-full-access]（read-only | workspace-write | danger-full-access）：`)).trim()

    const next: HarnessConfig = {
      ...existing,
      apiKey,
      baseUrl: baseUrl || 'https://api.deepseek.com/v1',
      model: model || 'deepseek-v4-flash',
      workspace: workspace || process.cwd(),
      level: (levelRaw || 'danger-full-access') as HarnessConfig['level'],
    }
    const path = saveConfig(next)
    out(`✓ 配置已保存到 ${path}`)
    out(`  模型：${next.model} · 工作区：${next.workspace} · 沙箱：${next.level}`)
  } finally {
    rl.close()
  }
}

async function cmdConfig(args: string[]): Promise<void> {
  const [sub, key, value] = args
  const cfg = loadConfig()
  switch (sub) {
    case 'get': {
      if (!key) {
        outError('用法：harness config get <key>')
        process.exitCode = 2
        return
      }
      const v = cfg[key]
      out(key === 'apiKey' ? maskSecrets(String(v ?? '')) : String(v ?? '(未设置)'))
      break
    }
    case 'set': {
      if (!key || value === undefined) {
        outError('用法：harness config set <key> <value>')
        process.exitCode = 2
        return
      }
      saveConfig({ ...cfg, [key]: value })
      out(key === 'apiKey' ? `✓ apiKey 已更新（${maskSecrets(value)}）` : `✓ ${key} = ${value}`)
      break
    }
    case 'rm': {
      if (!key) {
        outError('用法：harness config rm <key>')
        process.exitCode = 2
        return
      }
      const { [key]: _removed, ...rest } = cfg
      saveConfig(rest)
      out(`✓ 已移除 ${key}`)
      break
    }
    case 'list': {
      if (Object.keys(cfg).length === 0) {
        out('（配置为空，运行 harness login 配置）')
        return
      }
      for (const [k, v] of Object.entries(cfg)) {
        out(k === 'apiKey' ? `  ${k} = ${maskSecrets(String(v))}` : `  ${k} = ${String(v)}`)
      }
      break
    }
    default:
      outError('用法：harness config <get|set|list|rm> [key] [value]')
      process.exitCode = 2
  }
}

async function cmdRun(args: string[]): Promise<void> {
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
  const level = (values.level ?? cfg.level ?? 'danger-full-access') as 'read-only' | 'workspace-write' | 'danger-full-access'
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
    })) {
      const cfgOpt = def.name === 'harness-session' ? { storeDir: sessionDir } : undefined
      await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
    }
    marks.mounted = Date.now()

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
      out('\n===== 结果 =====')
      out(result.content || '(无内容输出)')
      out(`\n（步骤数：${result.steps}，结束原因：${result.finishedReason}，会话：${result.sessionId}）`)
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

async function cmdValidate(args: string[]): Promise<void> {
  const filePath = args[0]
  if (!filePath) {
    outError('用法：harness validate <插件路径>')
    process.exitCode = 2
    return
  }
  try {
    const mod = await loadPluginModule(filePath)
    const def = normalizePlugin(mod)
    out(`${fmt.green('✓')} 插件 "${def.name}" 校验通过`)
    if (def.version) out(`  版本：${def.version}`)
    if (def.description) out(`  描述：${def.description}`)
    out(`  inject：${def.inject?.length ? def.inject.join(', ') : '（无）'}`)
    out(`  provides：${def.provides?.length ? def.provides.join(', ') : '（无）'}`)
    // 开发期建议
    if (!def.description) out(`  ${fmt.yellow('建议：')}补充 description 描述插件用途`)
    if (def.inject && def.inject.length === 0 && !def.provides) {
      out(`  ${fmt.yellow('建议：')}插件既无依赖也无提供服务，仅用于副作用（事件/工具）时请确认`)
    }
  } catch (err) {
    const he = HarnessError.from(err)
    outError(`${fmt.red('✗')} 校验失败：${he.message}`)
    if (he.hint) outError(`  提示：${he.hint}`)
    process.exitCode = 2
  }
}

async function cmdCreatePlugin(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    outError('用法：harness create-plugin <名称>')
    process.exitCode = 2
    return
  }
  const dir = resolve(args[1] ?? join('plugins', name))
  await mkdir(join(dir, 'src'), { recursive: true })

  const indexContent = `import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = '${name}'
export const version = '0.1.0'
export const description = ''

// 声明依赖的服务（就绪后 apply 才会执行）
export const inject = ['tools']

export function apply(ctx: Context) {
  const tools = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools')

  // 能力一：注册工具（模型可调用）；注销函数绑定 ctx.effect，卸载/热重载自动清理
  const unregisterTool = tools.register(
    defineTool({
      name: '${name}_hello',
      description: '示例工具：问候',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      execute: async (args) => ({ text: \`你好，\${String(args.name)}！\` }),
    }),
  )

  // 能力二：订阅事件（可拦截/记录 agent 执行）
  ctx.on('agent/pre-step', (payload) => {
    ctx.logger.debug('[${name}] pre-step', payload)
  })

  // 能力三：可逆副作用（插件卸载时自动清理）
  ctx.effect(() => {
    unregisterTool()
    ctx.logger.info('[${name}] unloaded')
  })

  ctx.logger.info('[${name}] loaded')
}
`
  await writeFile(join(dir, 'src', 'index.ts'), indexContent, 'utf-8')

  const pkgContent = `{
  "name": "${name}",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@zhuxing/harness-sdk": "workspace:^0.1.0",
    "typescript": "^5.7.0"
  }
}
`
  await writeFile(join(dir, 'package.json'), pkgContent, 'utf-8')

  const tsconfigContent = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`
  await writeFile(join(dir, 'tsconfig.json'), tsconfigContent, 'utf-8')

  out(`${fmt.green('✓')} 插件脚手架已生成：${dir}`)
  out('  下一步：')
  out(`  1. 实现能力后校验：harness validate ${join(dir, 'src', 'index.ts')}`)
  out('  2. 通过 patch 接入：在配置中写入 path 指向 src/index.ts')
}

async function cmdInstall(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { as: { type: 'string' } },
    allowPositionals: true,
  })
  const source = positionals[0]
  if (!source) {
    outError('用法：harness install <插件源目录> [--as <名称>]')
    process.exitCode = 2
    return
  }
  const name = values.as ?? basename(resolve(source))
  const target = resolve('plugins', name)
  await cp(resolve(source), target, {
    recursive: true,
    filter: (src) => {
      const base = basename(src)
      return base !== 'node_modules' && base !== '.git' && base !== 'dist' && base !== '.harness-cache'
    },
  })
  out(`${fmt.green('✓')} 已安装插件到 ${target}`)
  out('\n接入 harness（写入 patch 文件）：')
  out(`  plugins:\n    - id: ${name}\n      path: ${join(target, 'src', 'index.ts')}`)
}

async function cmdList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      patch: { type: 'string', short: 'p', multiple: true },
      profile: { type: 'string' },
    },
  })
  const { plugins, sources } = await resolvePlugins({
    profile: values.profile,
    patches: values.patch,
    cwd: process.cwd(),
  })
  out(`配置来源：${sources.length > 0 ? sources.join(' → ') : '（无，仅默认）'}\n`)
  if (plugins.length === 0) {
    out('（未解析到任何插件）')
    return
  }
  for (const p of plugins) {
    const state = p.enabled === false ? 'disabled' : 'enabled'
    const source = p.path ? p.path : '(inline)'
    out(`[${state}] ${p.id}\t${source}`)
  }
}

/** 解析会话 id：支持完整 id 或唯一前缀。 */
async function resolveSessionId(store: FileSessionStore, partial: string): Promise<string | null> {
  const ids = await store.listSessions()
  if (ids.includes(partial)) return partial
  const matches = ids.filter((i) => i.startsWith(partial))
  return matches.length === 1 ? matches[0] : null
}

async function cmdSession(args: string[]): Promise<void> {
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
        const time = first ? new Date(first.ts).toISOString().replace('T', ' ').slice(0, 19) : '-'
        out(`  ${sid.slice(0, 8)}  ${String(events.length).padStart(4)} 事件  ${time}`)
      }
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
      outError('用法：harness session <ls|show|rm> [会话id]')
      process.exitCode = 2
  }
}

/** 文件内容哈希（用于 dev 变化检测）。 */
async function hashFile(path: string): Promise<string> {
  const content = await readFile(path, 'utf-8')
  return createHash('sha256').update(content).digest('hex')
}

async function cmdDev(args: string[]): Promise<void> {
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
  const level = (values.level ?? cfg.level ?? 'danger-full-access') as 'read-only' | 'workspace-write' | 'danger-full-access'
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
  })) {
    const cfgOpt = def.name === 'harness-session' ? { storeDir: sessionDir } : undefined
    await app.mount(def, cfgOpt ? { config: cfgOpt } : undefined)
  }

  const agentRecord = app.pluginManager.get('harness-agent')
  if (!agentRecord) throw new HarnessError('Agent 循环未就绪', 'PLUGIN')
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

/** 启动 Web UI（对话 / 工作 / 交付）。 */
async function cmdWeb(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
    },
  })
  const { startWebServer } = await import('@zhuxing/harness-web')
  const handle = await startWebServer({
    port: values.port ? Number(values.port) : 3080,
    host: values.host ?? '127.0.0.1',
  })
  out(`${fmt.green('✓')} 筑星 Harness Web UI 已启动：${handle.url}`)
  out('（Ctrl-C 退出）')
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop)
  })
  await new Promise<void>((resolveClose) => handle.server.close(() => resolveClose()))
}

/** 环境自检：版本、配置、目录可写、可选端点连通性。 */
async function cmdDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { network: { type: 'boolean' } } })
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'Node 版本', ok: nodeMajor >= 20, detail: process.versions.node })

  const cfg = loadConfig()
  const cfgPath = configPath()
  const keySource = cfg.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY
  checks.push({
    name: 'API Key',
    ok: Boolean(keySource),
    detail: keySource ? `已配置（${maskSecrets(String(keySource))}）` : `未配置（配置文件：${cfgPath}，或运行 harness login）`,
  })

  const sessionDir = process.env.HARNESS_SESSION_DIR ?? join(homedir(), '.zhuxing-harness', 'sessions')
  let dirOk = true
  try {
    await mkdir(sessionDir, { recursive: true })
  } catch {
    dirOk = false
  }
  checks.push({ name: '会话目录', ok: dirOk, detail: sessionDir })
  checks.push({ name: '沙箱默认级别', ok: true, detail: cfg.level ?? 'danger-full-access（最高权限，可通过 --level 降级）' })
  checks.push({ name: '模型默认', ok: true, detail: cfg.model ?? 'deepseek-v4-flash' })

  if (values.network) {
    const baseUrl = (cfg.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/$/, '')
    if (keySource) {
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${keySource}` },
          signal: AbortSignal.timeout(10_000),
        })
        checks.push({ name: `端点连通（${baseUrl}）`, ok: res.ok, detail: `HTTP ${res.status}` })
      } catch (err) {
        checks.push({ name: `端点连通（${baseUrl}）`, ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    } else {
      checks.push({ name: '端点连通', ok: false, detail: '缺少 API Key，跳过网络检查' })
    }
  }

  out(`筑星 Harness v${VERSION} · Node ${process.versions.node}`)
  let failed = false
  for (const c of checks) {
    out(`${c.ok ? fmt.green('✓') : fmt.red('✗')} ${c.name}：${c.detail}`)
    if (!c.ok) failed = true
  }
  if (failed) {
    out('\n存在需修复的检查项，请按提示处理。')
    process.exitCode = 1
  } else {
    out(`\n${fmt.green('✓')} 环境就绪，可正常运行 harness。`)
  }
}

async function cmdCompletion(args: string[]): Promise<void> {
  const shell = args[0] ?? 'bash'
  const commands = 'run dev login config session validate create-plugin install list doctor version completion help'
  if (shell === 'zsh') {
    out(`#compdef harness
_harness() {
  local -a cmds
  cmds=(${commands})
  _describe 'command' cmds
}
compdef _harness harness`)
    return
  }
  out(`# bash completion for harness
_harness() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${commands}"
  COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") )
}
complete -F _harness harness`)
}

main().catch((err) => {
  const he = HarnessError.from(err)
  outError(`${fmt.red('✗')} 执行失败：${he.message}`)
  if (he.hint) outError(`  提示：${he.hint}`)
  process.exitCode = 1
})
