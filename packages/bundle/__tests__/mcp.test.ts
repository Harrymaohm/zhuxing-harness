/**
 * MCP stdio 客户端测试：断言**行为**（真实子进程 + 真实工具注册表 + 真实插件装配）。
 *
 * 每一条对应用户验收清单里的一项。fixture 见 ./fixtures/mcp-server.mjs（手写 JSON-RPC，
 * 不使用任何 MCP SDK）；`--trace` 让测试能断言"客户端到底发了什么"。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '@zhuxing/harness-kernel'
import { createHarness } from '@zhuxing/harness-kernel'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import type { ToolDefinition, ToolRegistry } from '@zhuxing/harness-tools'
import {
  DEFAULT_MCP_RESULT_MAX_BYTES,
  MCP_LEGACY_VERSION,
  MCP_MODERN_VERSION,
  McpClientManager,
  baseBundlePlugins,
  mcpToolName,
  parseMcpServers,
} from '../src/index.js'
import type { McpServerConfig } from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))

const tempDirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      /* 清理失败不掩盖断言结果 */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'h-mcp-'))
  tempDirs.push(dir)
  return dir
}

interface CapturedLogger extends Logger {
  warnings: string[]
  infos: string[]
}

function captureLogger(): CapturedLogger {
  const warnings: string[] = []
  const infos: string[] = []
  const push = (list: string[]) => (msg: string) => {
    list.push(msg)
  }
  return {
    warnings,
    infos,
    trace: () => undefined,
    debug: () => undefined,
    info: push(infos),
    warn: push(warnings),
    error: push(warnings),
  }
}

interface Rig {
  logger: CapturedLogger
  registry: ToolRegistry
  manager: McpClientManager
  trace(): Array<Record<string, unknown>>
  names(): string[]
}

/** 用真实子进程 + 真实注册表起一个（或多个）server。 */
async function rig(specs: Array<{ name: string; flags?: string[]; over?: Partial<McpServerConfig> }>): Promise<Rig> {
  const dir = tempDir()
  const traceFile = join(dir, 'trace.ndjson')
  const servers: McpServerConfig[] = specs.map((spec) => ({
    name: spec.name,
    command: process.execPath,
    args: [FIXTURE, '--trace', traceFile, ...(spec.flags ?? [])],
    timeouts: { initMs: 5000, listMs: 5000, callMs: 5000 },
    resultMaxBytes: DEFAULT_MCP_RESULT_MAX_BYTES,
    ...(spec.over ?? {}),
  }))
  const logger = captureLogger()
  const registry = new ToolRegistryImpl()
  const manager = new McpClientManager({
    servers,
    logger,
    clientInfo: { name: 'test-client', version: '0.0.0' },
  })
  cleanups.push(() => manager.dispose())
  await manager.ready()
  manager.registerTools(registry)
  return {
    logger,
    registry,
    manager,
    trace: () => {
      if (!existsSync(traceFile)) return []
      return readFileSync(traceFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    },
    names: () => registry.list().map((t) => t.name),
  }
}

const requests = (r: Rig) => r.trace().filter((x) => x.kind === 'request')
const methods = (r: Rig) => requests(r).map((x) => String(x.method))
const metaOfMethod = (r: Rig, method: string) => requests(r).find((x) => x.method === method)?.meta as
  | Record<string, unknown>
  | undefined

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 1. 握手成功（现代）

describe('MCP 客户端 / 握手', () => {
  it('现代服务端：server/discover → 每请求 _meta → 工具以 mcp__<server>__<tool> 注册且 schema 直通', async () => {
    const r = await rig([{ name: 'srv' }])
    const status = r.manager.statuses()[0]
    expect(status.connected).toBe(true)
    expect(status.era).toBe('modern')
    expect(status.protocolVersion).toBe(MCP_MODERN_VERSION)
    expect(r.names()).toEqual(['mcp__srv__echo', 'mcp__srv__write_file', 'mcp__srv__env_probe', 'mcp__srv__slow'])

    // schema 直通：MCP 的 inputSchema 原样作为注册表的 schema。
    const echo = r.registry.get('mcp__srv__echo') as ToolDefinition
    expect(echo.schema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' }, nested: { type: 'object', properties: { n: { type: 'number' } } } },
      required: ['text'],
    })
    expect(echo.description).toBe('原样返回参数（用于断言参数透传）')

    // 现代路径 = server/discover + 每请求 _meta；**没有** initialize、没有 notifications/initialized。
    expect(methods(r)).toEqual(['server/discover', 'tools/list'])
    expect(metaOfMethod(r, 'tools/list')).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '0.0.0' },
    })
    expect(r.trace().some((x) => x.method === 'initialize')).toBe(false)
    expect(r.trace().some((x) => x.method === 'notifications/initialized')).toBe(false)
  })

  // ---------------------------------------------------------------- 2. 旧版本服务端

  it('旧版服务端：回落 initialize（发 2025-06-18）→ notifications/initialized → 后续请求不带 _meta', async () => {
    const r = await rig([{ name: 'old', flags: ['--era', 'legacy'] }])
    const status = r.manager.statuses()[0]
    expect(status.connected).toBe(true)
    expect(status.era).toBe('legacy')
    expect(status.protocolVersion).toBe(MCP_LEGACY_VERSION)
    expect(r.names()).toEqual(['mcp__old__echo', 'mcp__old__write_file', 'mcp__old__env_probe', 'mcp__old__slow'])

    const init = requests(r).find((x) => x.method === 'initialize')
    expect(init?.params).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    })
    // 旧版请求不得携带 _meta（只有现代版本把元数据内联在每请求 _meta 里）。
    expect(Object.keys(init?.params as object).sort()).toEqual(['capabilities', 'clientInfo', 'protocolVersion'])
    expect(r.trace().some((x) => x.method === 'notifications/initialized')).toBe(true)
    // 旧版：探测先发生（server/discover 被回 -32601），且后续请求不带 _meta。
    expect(methods(r)[0]).toBe('server/discover')
    expect(metaOfMethod(r, 'tools/list')).toBeUndefined()
  })

  // ---------------------------------------------------------------- 3. 不支持的版本

  it('旧版服务端回不支持的版本（2025-03-26）→ 断开、工具不注册、有可读告警', async () => {
    const r = await rig([{ name: 'old', flags: ['--era', 'legacy', '--init-version', '2025-03-26'] }])
    expect(r.manager.statuses()[0].connected).toBe(false)
    expect(r.manager.statuses()[0].error).toContain('2025-03-26')
    expect(r.names()).toEqual([])
    expect(r.logger.warnings.join('\n')).toContain('2025-03-26')
  })

  it('现代服务端声明只支持别的版本（-32022 / 2025-11-25）→ 断开，且**不**回落 initialize', async () => {
    const r = await rig([
      { name: 'm', flags: ['--discover-error', '-32022', '--discover-supported', '2025-11-25'] },
    ])
    expect(r.manager.statuses()[0].connected).toBe(false)
    expect(r.manager.statuses()[0].error).toContain('2025-11-25')
    expect(r.names()).toEqual([])
    // 规范：可识别的现代错误 → 不得回落 initialize。
    expect(r.trace().some((x) => x.method === 'initialize')).toBe(false)
  })

  it('现代 DiscoverResult 里没有我们支持的版本 → 断开（且不回落 initialize）', async () => {
    const r = await rig([{ name: 'm', flags: ['--discover-versions', '2025-11-25'] }])
    expect(r.manager.statuses()[0].connected).toBe(false)
    expect(r.manager.statuses()[0].error).toContain('2025-11-25')
    expect(r.names()).toEqual([])
    expect(r.trace().some((x) => x.method === 'initialize')).toBe(false)
  })

  // ---------------------------------------------------------------- 4. 分页

  it('tools/list 分页：取完所有页，工具数量正确（含空字符串 cursor 是合法 cursor）', async () => {
    const r = await rig([{ name: 'srv', flags: ['--page-size', '1'] }])
    expect(r.names()).toHaveLength(4)
    const lists = requests(r).filter((x) => x.method === 'tools/list')
    expect(lists).toHaveLength(4)
    expect(lists.map((x) => (x.params as { cursor?: string } | undefined)?.cursor)).toEqual([
      undefined,
      '1',
      '2',
      '3',
    ])

    const empty = await rig([{ name: 'e', flags: ['--page-size', '1', '--empty-cursor'] }])
    expect(empty.names()).toHaveLength(4)
    const emptyLists = requests(empty).filter((x) => x.method === 'tools/list')
    expect(emptyLists.map((x) => (x.params as { cursor?: string } | undefined)?.cursor)).toContain('')
    expect(emptyLists).toHaveLength(4)
  })

  it('server/discover 无响应（超时）→ 按旧版回落 initialize（规范给定的 stdio 探测规则）', async () => {
    const r = await rig([
      {
        name: 'quiet',
        flags: ['--era', 'legacy', '--silent-discover'],
        over: { timeouts: { initMs: 400, listMs: 3000, callMs: 3000 } },
      },
    ])
    const status = r.manager.statuses()[0]
    expect(status.connected).toBe(true)
    expect(status.era).toBe('legacy')
    expect(requests(r).some((x) => x.method === 'initialize')).toBe(true)
    expect(metaOfMethod(r, 'tools/list')).toBeUndefined()
  })

  it('工具缺少 inputSchema → 告警并跳过该工具，其余工具照常注册', async () => {
    const r = await rig([{ name: 'srv', flags: ['--no-schema'] }])
    expect(r.names()).toEqual(['mcp__srv__echo', 'mcp__srv__write_file', 'mcp__srv__env_probe', 'mcp__srv__slow'])
    expect(r.logger.warnings.join('\n')).toContain('no_schema')
    expect(r.logger.warnings.join('\n')).toContain('inputSchema')
  })
})

// ---------------------------------------------------------------- 5~7. 工具调用 / 错误 / 截断

describe('MCP 客户端 / 工具调用', () => {
  it('工具调用：args 原样透传、结果文本映射正确、现代调用带 _meta', async () => {
    const r = await rig([{ name: 'srv' }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'hi', nested: { n: 1 } }, {})
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('echo:{"text":"hi","nested":{"n":1}}')
    const call = requests(r).find((x) => x.method === 'tools/call')
    expect(call?.params).toMatchObject({ name: 'echo', arguments: { text: 'hi', nested: { n: 1 } } })
    expect((call?.meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']).toBe(MCP_MODERN_VERSION)
  })

  it('命名空间隔离：内建 write_file 与 mcp__srv__write_file 并存，互不影响', async () => {
    const r = await rig([{ name: 'srv' }])
    let builtinCalls = 0
    r.registry.register({
      name: 'write_file',
      description: '内建同名单词工具',
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => {
        builtinCalls += 1
        return { text: 'builtin' }
      },
    })
    const mcpResult = await r.registry.execute('mcp__srv__write_file', { path: '/tmp/x', content: 'c' }, {})
    expect(mcpResult.text).toContain('echo:')
    const builtinResult = await r.registry.execute('write_file', { path: '/tmp/x' }, {})
    expect(builtinResult.text).toBe('builtin')
    expect(builtinCalls).toBe(1)
  })

  it('isError: true → ToolResult 是 { error } 且含服务端给出的原因', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'is-error'] }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.text).toBeUndefined()
    expect(result.error).toContain('API rate limit exceeded')
  })

  it('非文本内容类型如实降级并说明（不假装支持图片/音频）', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'mixed'] }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.text).toContain('文本部分')
    expect(result.text).toContain('图片内容已降级省略')
    expect(result.text).toContain('音频内容已降级省略')
    expect(result.text).toContain('资源链接：file:///tmp/x')
    expect(result.text).toContain('嵌入文本')
    expect(result.text).toContain('weird_future_type')
  })

  it('只有 structuredContent 时用其 JSON 兜底', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'structured-only'] }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.text).toContain('"answer":42')
  })

  it('结果大小上限：超大文本被截断并标注（断言长度上限与提示语）', async () => {
    const r = await rig([
      { name: 'srv', flags: ['--call-mode', 'big', '--big-size', '200000'], over: { resultMaxBytes: 1024 } },
    ])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const text = String(result.text)
    expect(text).toContain('结果已截断')
    expect(text).toContain('上限 1024 字节')
    expect(text).toContain('200000 字节')
    // 截断后的正文（不含标注行）不超过上限。
    const body = text.split('\n…（结果已截断')[0]
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(1024)
  })

  it('协议级错误（JSON-RPC error）→ 可读的 { error }', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'rpc-error'] }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.error).toContain('工具执行失败')
  })

  it('服务端以 input_required 要求交互 → 如实报错，不伪造输入、不崩', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'input-required'] }])
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.error).toContain('input_required')
    expect(result.error).toContain('未声明 elicitation')
  })

  // ---------------------------------------------------------------- 8. 超时

  it('超时：服务端不响应 → 调用在超时后以可读错误失败（并发取消通知）', async () => {
    const r = await rig([{ name: 'srv', flags: ['--call-mode', 'hang'], over: { timeouts: { initMs: 3000, listMs: 3000, callMs: 300 } } }])
    const started = Date.now()
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const elapsed = Date.now() - started
    expect(result.error).toContain('超时')
    expect(result.error).toContain('server=srv')
    expect(elapsed).toBeLessThan(3000)
    const cancelled = r.trace().filter((x) => x.kind === 'notification' && x.method === 'notifications/cancelled')
    expect(cancelled.length).toBeGreaterThan(0)
  })

  it('握手失败（旧版 initialize 报错）→ 该 server 不可用、工具不注册', async () => {
    const r = await rig([{ name: 'srv', flags: ['--era', 'legacy', '--init-error'] }])
    expect(r.manager.statuses()[0].connected).toBe(false)
    expect(r.names()).toEqual([])
    expect(r.logger.warnings.join('\n')).toContain('不可用')
  })
})

// ---------------------------------------------------------------- 9~11. 生命周期 / 容错

describe('MCP 客户端 / 生命周期与容错', () => {
  it('启动不阻断：不存在的 command → harness 正常启动并挂载其它插件，该 server 工具不注册', async () => {
    const app = createHarness({ logLevel: 'error' })
    cleanups.push(() => app.dispose())
    const defs = baseBundlePlugins({
      apiKey: 'k',
      model: 'm',
      workspace: process.cwd(),
      level: 'workspace-write',
      memoryPath: join(tempDir(), 'memory.json'),
      skillsDirs: [join(tempDir(), 'skills')],
      mcpServers: { ghost: { command: 'definitely-not-a-real-command-xyz', args: [] } },
    })
    for (const def of defs) await app.mount(def)
    // 其它插件照常就绪（不因 MCP 连接失败而阻断）。
    expect(app.pluginManager.get('harness-agent')).toBeTruthy()
    expect(app.pluginManager.get('harness-mcp-client')).toBeTruthy()
    const manager = app.services.get<McpClientManager>('mcp') as McpClientManager
    await manager.ready()
    expect(manager.statuses()[0].connected).toBe(false)
    expect(manager.statuses()[0].error).toBeTruthy()
    const tools = app.pluginManager.get('harness-tools')!.ctx.inject<ToolRegistry>('tools')
    expect(tools.list().filter((t) => t.name.startsWith('mcp__'))).toEqual([])
  })

  it('进程清理：插件 unmount 后 fixture 子进程确实退出（无残留）', async () => {
    const r = await rig([{ name: 'srv' }])
    const pid = r.manager.pids()[0].pid
    expect(typeof pid).toBe('number')
    expect(isProcessAlive(pid as number)).toBe(true)
    await r.manager.dispose()
    const deadline = Date.now() + 5000
    while (isProcessAlive(pid as number) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(isProcessAlive(pid as number)).toBe(false)
    expect(r.manager.registeredToolNames()).toEqual([])
  })

  it('stdout 污染容错：非 MCP 内容只告警不崩，后续请求仍能完成', async () => {
    const r = await rig([{ name: 'srv', flags: ['--pollute-stdout'] }])
    expect(r.manager.statuses()[0].connected).toBe(true)
    expect(r.names()).toHaveLength(4)
    expect(r.logger.warnings.join('\n')).toContain('非 MCP 内容')
    const first = await r.registry.execute('mcp__srv__echo', { text: 'a' }, {})
    const second = await r.registry.execute('mcp__srv__echo', { text: 'b' }, {})
    expect(first.text).toBe('echo:{"text":"a"}')
    expect(second.text).toBe('echo:{"text":"b"}')
  })

  it('服务端主动发请求（roots/sampling）→ 客户端拒绝且不崩；现代版本下忽略', async () => {
    const legacy = await rig([
      { name: 'srv', flags: ['--era', 'legacy', '--server-request', 'sampling/createMessage', '--server-request-era', 'legacy'] },
    ])
    const legacyResult = await legacy.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(legacyResult.text).toContain('echo:')
    expect(legacy.logger.warnings.join('\n')).toContain('sampling/createMessage')
    const replies = legacy.trace().filter((x) => x.kind === 'client-response')
    expect(replies[0]?.hasError).toBe(true)
    expect(replies[0]?.code).toBe(-32601)

    const modern = await rig([
      { name: 'srv', flags: ['--server-request', 'sampling/createMessage', '--server-request-era', 'modern'] },
    ])
    const modernResult = await modern.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(modernResult.text).toContain('echo:')
    expect(modern.logger.warnings.join('\n')).toContain('禁止服务端向客户端发请求')
    // 现代版本：客户端 MUST NOT 写响应，故 fixture 收不到任何回应。
    expect(modern.trace().filter((x) => x.kind === 'client-response')).toEqual([])
  })

  it('tools/list_changed 通知被容忍（不动态刷新、不崩）', async () => {
    const r = await rig([{ name: 'srv', flags: ['--notify-on-list'] }])
    expect(r.manager.statuses()[0].connected).toBe(true)
    expect(r.logger.infos.join('\n')).toContain('工具列表已变化')
  })

  it('进程意外退出 → 标记不可用并告警，工具调用返回可读错误（不自动重连）', async () => {
    const r = await rig([{ name: 'srv', flags: ['--exit-after', '2'] }])
    // 前两条消息（server/discover + tools/list）处理完即退出 → 连接成功但随后进程消失。
    await new Promise((resolve) => setTimeout(resolve, 300))
    const result = await r.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    expect(result.error).toBeTruthy()
    expect(r.logger.warnings.join('\n')).toContain('不做自动重连')
  })
})

// ---------------------------------------------------------------- 12~13. 配置校验 / 权限声明

describe('MCP 配置解析与权限声明', () => {
  it('配置校验：缺 command / 名含 __ / args 非数组 / env 非字符串 / 非 stdio → 各自告警并跳过，不影响其它 server', () => {
    const parsed = parseMcpServers({
      good: { command: 'node', args: ['a'], env: { K: 'v' }, cwd: '/tmp' },
      missingCommand: { args: ['a'] },
      'bad__name': { command: 'node' },
      badArgs: { command: 'node', args: 'oops' },
      badEnv: { command: 'node', env: { K: 1 } },
      badCwd: { command: 'node', cwd: 42 },
      httpish: { command: 'node', url: 'https://example.com/mcp' },
      disabledOne: { command: 'node', disabled: true },
      onlyCommand: { command: 'node' },
    })
    expect(parsed.servers.map((s) => s.name)).toEqual(['good', 'onlyCommand'])
    const warnings = parsed.warnings.join('\n')
    expect(warnings).toContain('缺少必填的 command')
    expect(warnings).toContain('__')
    expect(warnings).toContain('args 必须是字符串数组')
    expect(warnings).toContain('env.K 必须是字符串')
    expect(warnings).toContain('cwd 必须是非空字符串')
    expect(warnings).toContain('只支持 stdio')
    expect(warnings).toContain('disabled')
  })

  it('配置校验：顶层不是对象 → 整体忽略并告警；未配置 → 无告警无插件', () => {
    expect(parseMcpServers(['nope']).servers).toEqual([])
    expect(parseMcpServers(['nope']).warnings.join()).toContain('必须是对象')
    expect(parseMcpServers(undefined)).toEqual({ servers: [], warnings: [] })
    expect(baseBundlePlugins({ apiKey: 'k', model: 'm', workspace: process.cwd(), level: 'workspace-write' }).some((p) => p.name === 'harness-mcp-client')).toBe(false)
  })

  it('超时与结果上限可配置覆盖（含 shared timeoutMs 与单项覆盖）', () => {
    const parsed = parseMcpServers({
      a: { command: 'node', timeoutMs: 1234, callTimeoutMs: 4321 },
      b: { command: 'node', resultMaxBytes: 2048 },
    })
    const a = parsed.servers.find((s) => s.name === 'a')!
    expect(a.timeouts).toEqual({ initMs: 1234, listMs: 1234, callMs: 4321 })
    expect(parsed.servers.find((s) => s.name === 'b')!.resultMaxBytes).toBe(2048)
    const bad = parseMcpServers({ c: { command: 'node', timeoutMs: -5 } })
    expect(bad.servers[0].timeouts.initMs).toBe(10_000)
    expect(bad.warnings.join()).toContain('必须是正数')
  })

  it('权限声明：harness-mcp-client 的 permissions.shell 含配置里的所有 command', () => {
    const plugins = baseBundlePlugins({
      apiKey: 'k',
      model: 'm',
      workspace: process.cwd(),
      level: 'workspace-write',
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        local: { command: '/usr/bin/node', args: ['/tmp/srv.mjs'] },
      },
    })
    expect(plugins.map((p) => p.name)).toContain('harness-mcp-client')
    // 位置：紧随内建工具插件（见 index.ts 的顺序注释）。
    expect(plugins.findIndex((p) => p.name === 'harness-mcp-client')).toBe(
      plugins.findIndex((p) => p.name === 'harness-core-tools') + 1,
    )
    const mcp = plugins.find((p) => p.name === 'harness-mcp-client')!
    expect(mcp.permissions?.shell).toEqual(['npx', '/usr/bin/node'])
    expect(mcp.inject).toEqual(['tools'])
    expect(mcp.provides).toEqual(['mcp'])
  })

  it('工具名映射：非法字符被替换，server 名作为命名空间前缀', () => {
    expect(mcpToolName('srv', 'read')).toBe('mcp__srv__read')
    expect(mcpToolName('srv', 'a b/c')).toBe('mcp__srv__a_b_c')
    expect(mcpToolName('srv', 'admin.tools.list')).toBe('mcp__srv__admin.tools.list')
  })
})
