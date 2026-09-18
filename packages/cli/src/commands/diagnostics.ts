import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHarness, maskSecrets } from '@zhuxing/harness-kernel'
import type { ToolRegistry } from '@zhuxing/harness-tools'
import { baseBundlePlugins, renderSelfKnowledge, summarizePluginPermissions } from '@zhuxing/harness-bundle'
import type { McpClientManager } from '@zhuxing/harness-bundle'
import { DEFAULT_PERMISSION_LEVEL } from '@zhuxing/harness-sandbox'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'
import { loadConfig, configPath } from '../config-store.js'
import { fmt, out, outError } from '../output.js'
import { VERSION } from '../version.js'

/**
 * 本体自省：按话题输出「软件本体知识」（与 Agent 工具 harness_help 共用同一实现）。
 * 挂载基础 bundle 以取到真实的插件与工具清单；不发起任何模型请求。
 */
export async function cmdIntrospect(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
      workspace: { type: 'string', short: 'w' },
    },
    allowPositionals: true,
  })
  const cfg = loadConfig()
  const workspace = resolve(values.workspace ?? cfg.workspace ?? process.cwd())
  const app = createHarness({ logLevel: 'warn' })
  try {
    for (const def of baseBundlePlugins({
      apiKey: cfg.apiKey ?? '',
      baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1',
      model: cfg.model ?? 'deepseek-v4-flash',
      workspace,
      level: (cfg.level ?? DEFAULT_PERMISSION_LEVEL) as PermissionLevel,
      // 自省/审计视图必须如实反映 MCP server（含 permissions.shell 里的 command）与其工具。
      mcpServers: cfg.mcpServers,
    })) {
      await app.mount(def)
    }
    await app.services.get<McpClientManager>('mcp')?.ready()
  } catch (err) {
    outError(`[cli] 基础 bundle 挂载失败，插件与工具清单可能不完整：${err instanceof Error ? err.message : String(err)}`)
  }
  const plugins = app.pluginManager.list().map((r) => ({
    id: r.id,
    description: r.definition.description,
    enabled: r.state === 'mounted',
    permissions: summarizePluginPermissions(r.definition.permissions),
  }))
  const tools =
    app.services.get<ToolRegistry>('tools')?.list().map((t) => ({ name: t.name, description: t.description })) ?? []
  const topic = positionals[0] ?? 'overview'
  const text = renderSelfKnowledge(topic, { workspace, plugins, tools })
  if (values.json) {
    console.log(JSON.stringify({ topic, text }, null, 2))
    return
  }
  out(text)
}

/** 环境自检：版本、配置、目录可写、可选端点连通性。 */
export async function cmdDoctor(args: string[]): Promise<void> {
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
  checks.push({ name: '沙箱默认级别', ok: true, detail: `${cfg.level ?? DEFAULT_PERMISSION_LEVEL}（写操作限定在工作区内，可用 --level 调整）` })
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
