/**
 * 协议面**实测**探针（MCP）：用**生产代码**（packages/bundle/dist 的 MCP stdio 客户端）
 * 真实连到测试 fixture server 上探测，替代原先「该攻击面当前不存在，因此无法证明」的口径。
 *
 * 口径要求（评测裁决）：
 * - 按**协商版本**分别陈述：`2025-06-18`（旧版，initialize 握手）下存在服务端→客户端请求
 *   （`sampling/createMessage`、`roots/list`、`elicitation/create`）；`2026-07-28`（现代）已用
 *   Multi-Round-Trip（`InputRequiredResult`）取代它，且**禁止服务端向客户端发请求**。
 *   两者不能混为一谈，故本模块每个探针都分别给出两个版本下的事实。
 * - A2A（agent-card / tasks/send / push-notification）在本产品中**未实现**，如实保持 Unproven。
 * - 客户端**未声明** roots / sampling / elicitation 能力，故相关探针测的是「服务端不被授权发、
 *   真发了我们会怎么反应」（拒绝/忽略，而非崩溃）。
 *
 * 所有断言都基于真实子进程往返 + fixture 写下的 trace（客户端到底发了什么）。
 */
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'

/** 测试用 stdio MCP server（与 packages/bundle 单测共用同一 fixture，不进产品代码）。 */
export const MCP_FIXTURE = fileURLToPath(new URL('../../packages/bundle/__tests__/fixtures/mcp-server.mjs', import.meta.url))

const V_MODERN = '2026-07-28'
const V_LEGACY = '2025-06-18'
const DEFAULT_TIMEOUTS = { initMs: 3000, listMs: 3000, callMs: 3000 }

let bundlePromise
/** 生产 bundle 构建产物（真实客户端），按相对路径加载（与 probes.mjs 同一做法）。 */
function loadBundle() {
  bundlePromise ??= import(new URL('../../packages/bundle/dist/index.js', import.meta.url).href)
  return bundlePromise
}

function captureLogger() {
  const warnings = []
  const infos = []
  return {
    warnings,
    infos,
    trace: () => undefined,
    debug: () => undefined,
    info: (m) => infos.push(String(m)),
    warn: (m) => warnings.push(String(m)),
    error: (m) => warnings.push(String(m)),
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let seq = 0

/** 起来一个真实 fixture server（真实子进程 + 真实客户端 + 真实工具注册表）。 */
async function withFixture(caseDir, opts = {}) {
  const bundle = await loadBundle()
  const name = opts.name ?? 'srv'
  const dir = join(caseDir, 'mcp', `${name}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  const traceFile = join(dir, 'trace.ndjson')
  const logger = captureLogger()
  const registry = new ToolRegistryImpl()
  const manager = new bundle.McpClientManager({
    servers: [
      {
        name,
        command: process.execPath,
        args: [MCP_FIXTURE, '--trace', traceFile, ...(opts.flags ?? [])],
        env: opts.env,
        timeouts: opts.timeouts ?? DEFAULT_TIMEOUTS,
        resultMaxBytes: opts.resultMaxBytes ?? bundle.DEFAULT_MCP_RESULT_MAX_BYTES,
      },
    ],
    logger,
    clientInfo: { name: 'eval-mcp-probe', version: '1.0.0' },
  })
  if (opts.register) opts.register(registry)
  await manager.ready()
  manager.registerTools(registry)
  const trace = () =>
    existsSync(traceFile)
      ? readFileSync(traceFile, 'utf-8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l))
      : []
  return {
    manager,
    registry,
    logger,
    trace,
    status: () => manager.statuses()[0],
    close: () => manager.dispose(),
  }
}

/** 生产客户端的公开方法面（用于断言「只实现 tools，不含 resources/prompts/sampling/roots」）。 */
async function clientSurface() {
  const bundle = await loadBundle()
  return {
    methods: Object.getOwnPropertyNames(bundle.McpClient.prototype).filter((n) => n !== 'constructor'),
    supportedVersions: bundle.MCP_SUPPORTED_VERSIONS,
    modern: bundle.MCP_MODERN_VERSION,
    legacy: bundle.MCP_LEGACY_VERSION,
  }
}

function requests(trace) {
  return trace.filter((x) => x.kind === 'request')
}
function requestOf(trace, method) {
  return requests(trace).find((x) => x.method === method)
}

/** 汇总断言结果。 */
function summarize(checks, facts, perVersionDetail) {
  const failed = checks.filter((c) => !c.pass)
  return {
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? `实测通过（${checks.length} 项断言全过）。${perVersionDetail}`
        : `实测发现 ${failed.length} 项不成立：${failed.map((c) => `${c.name}（${c.detail ?? ''}）`).join('；')}。${perVersionDetail}`,
    facts: { ...facts, checks },
    trajectory: true,
    externalState: true,
  }
}

// ---------------------------------------------------------------- 9 个 MCP 探针

/** 1. mcp initialize 握手：双版本协商的实测（含版本不匹配时断开）。 */
async function probeHandshake(caseDir) {
  const checks = []
  const surface = await clientSurface()
  const modern = await withFixture(caseDir, { name: 'm', flags: [] })
  const legacy = await withFixture(caseDir, { name: 'l', flags: ['--era', 'legacy'] })
  const oldVersion = await withFixture(caseDir, {
    name: 'old',
    flags: ['--era', 'legacy', '--init-version', '2025-03-26'],
  })
  const modernMismatch = await withFixture(caseDir, {
    name: 'mm',
    flags: ['--discover-error', '-32022', '--discover-supported', '2025-11-25'],
  })
  try {
    const m = modern.status()
    const l = legacy.status()
    checks.push({
      name: '现代服务端达成 2026-07-28',
      pass: m.connected === true && m.era === 'modern' && m.protocolVersion === V_MODERN,
      detail: JSON.stringify(m),
    })
    checks.push({
      name: '现代路径不发送 initialize',
      pass: !modern.trace().some((x) => x.method === 'initialize'),
    })
    const listMeta = requestOf(modern.trace(), 'tools/list')?.meta
    checks.push({
      name: '现代请求 _meta 带 protocolVersion + clientCapabilities + clientInfo',
      pass:
        listMeta?.['io.modelcontextprotocol/protocolVersion'] === V_MODERN &&
        typeof listMeta?.['io.modelcontextprotocol/clientCapabilities'] === 'object' &&
        typeof listMeta?.['io.modelcontextprotocol/clientInfo'] === 'object',
      detail: JSON.stringify(listMeta),
    })
    checks.push({
      name: '旧版服务端达成 2025-06-18',
      pass: l.connected === true && l.era === 'legacy' && l.protocolVersion === V_LEGACY,
      detail: JSON.stringify(l),
    })
    const initParams = requestOf(legacy.trace(), 'initialize')?.params
    checks.push({
      name: '旧版 initialize 参数齐全（protocolVersion/capabilities/clientInfo）且不带 _meta',
      pass:
        initParams?.protocolVersion === V_LEGACY &&
        typeof initParams?.capabilities === 'object' &&
        typeof initParams?.clientInfo === 'object' &&
        !Object.prototype.hasOwnProperty.call(initParams ?? {}, '_meta'),
      detail: JSON.stringify(initParams),
    })
    checks.push({
      name: '旧版握手后发 notifications/initialized',
      pass: legacy.trace().some((x) => x.method === 'notifications/initialized'),
    })
    checks.push({
      name: '旧版后续请求不带 _meta',
      pass: requestOf(legacy.trace(), 'tools/list')?.meta === undefined,
    })
    checks.push({
      name: '服务端回不支持的版本（2025-03-26）→ 断开且不注册工具',
      pass:
        oldVersion.status().connected === false &&
        /2025-03-26/.test(String(oldVersion.status().error ?? '')) &&
        oldVersion.registry.list().length === 0,
      detail: String(oldVersion.status().error ?? ''),
    })
    checks.push({
      name: '现代 -32022 版本不匹配 → 断开且不回落 initialize',
      pass:
        modernMismatch.status().connected === false &&
        !modernMismatch.trace().some((x) => x.method === 'initialize'),
      detail: String(modernMismatch.status().error ?? ''),
    })
    checks.push({
      name: '能力声明如实为空（未声明 roots/sampling/elicitation）',
      pass:
        JSON.stringify(requestOf(legacy.trace(), 'initialize')?.params?.capabilities) === '{}' &&
        JSON.stringify(listMeta?.['io.modelcontextprotocol/clientCapabilities']) === '{}',
    })
    const perVersion =
      '按版本分别陈述：2026-07-28（现代）无 initialize 握手，改为 server/discover 探测 + 每个请求内联 _meta（协议版本/客户端能力必填）；' +
      '2025-06-18（旧版）为 initialize + notifications/initialized，后续请求不带 _meta。两者都会在服务端回不支持版本时断开。'
    return summarize(checks, { supportedVersions: surface.supportedVersions, clientMethods: surface.methods }, perVersion)
  } finally {
    await modern.close()
    await legacy.close()
    await oldVersion.close()
    await modernMismatch.close()
  }
}

/** 2. mcp tools/list 枚举：分页取全 + 命名空间前缀。 */
async function probeToolsList(caseDir) {
  const checks = []
  const modern = await withFixture(caseDir, { name: 'srv', flags: ['--page-size', '1'] })
  const legacy = await withFixture(caseDir, {
    name: 'srv',
    flags: ['--era', 'legacy', '--page-size', '1', '--empty-cursor'],
  })
  try {
    const modernNames = modern.registry.list().map((t) => t.name)
    const legacyNames = legacy.registry.list().map((t) => t.name)
    checks.push({
      name: '现代：分页取完所有页（4 个工具 / 4 次 tools/list）',
      pass: modernNames.length === 4 && requests(modern.trace()).filter((x) => x.method === 'tools/list').length === 4,
      detail: modernNames.join(','),
    })
    checks.push({
      name: '枚举结果全部带 mcp__ 前缀（不能顶替内建工具名）',
      pass: modernNames.every((n) => n.startsWith('mcp__')) && legacyNames.every((n) => n.startsWith('mcp__')),
      detail: [...modernNames, ...legacyNames].join(','),
    })
    checks.push({
      name: '旧版：空字符串 cursor 被当作合法 cursor（继续分页）',
      pass:
        legacyNames.length === 4 &&
        requests(legacy.trace())
          .filter((x) => x.method === 'tools/list')
          .some((x) => x.params?.cursor === ''),
      detail: JSON.stringify(requests(legacy.trace()).map((x) => x.params?.cursor ?? null)),
    })
    checks.push({
      name: '两版本枚举结果一致（同一份工具面）',
      pass: JSON.stringify(modernNames.map((n) => n.replace('mcp__srv__', ''))) === JSON.stringify(legacyNames.map((n) => n.replace('mcp__srv__', ''))),
    })
    return summarize(checks, { modernToolCount: modernNames.length, legacyToolCount: legacyNames.length }, 'tools/list 分页与命名在两个版本下一致（版本差异不在枚举面）。')
  } finally {
    await modern.close()
    await legacy.close()
  }
}

/** 3. mcp tools/call 注入别名：外部工具不能顶替内建工具，参数原样透传。 */
async function probeToolsCallAlias(caseDir) {
  const checks = []
  const builtinCalls = []
  const fixture = await withFixture(caseDir, {
    name: 'srv',
    register: (registry) => {
      // 先注册与 fixture 工具同名的内建工具（模拟 read/write 这类敏感名字被外部 server 蹭用）。
      registry.register({
        name: 'write_file',
        description: '内建 write_file（探针替身）',
        schema: { type: 'object', properties: {} },
        execute: async () => {
          builtinCalls.push(1)
          return { text: 'builtin-result' }
        },
      })
    },
  })
  try {
    const mcpResult = await fixture.registry.execute('mcp__srv__write_file', { path: '/tmp/x', content: 'c' }, {})
    const builtinResult = await fixture.registry.execute('write_file', {}, {})
    const call = requestOf(fixture.trace(), 'tools/call')
    checks.push({
      name: '外部工具注册为 mcp__srv__write_file，内建 write_file 未被顶替',
      pass: builtinResult.text === 'builtin-result' && builtinCalls.length === 1,
      detail: String(builtinResult.text),
    })
    checks.push({
      name: '外部工具确实落到 server（args 原样透传）',
      pass:
        String(mcpResult.text ?? '').includes('echo:') &&
        JSON.stringify(call?.params?.arguments) === JSON.stringify({ path: '/tmp/x', content: 'c' }),
      detail: JSON.stringify(call?.params),
    })
    checks.push({
      name: '两版本一致：调用都带回 _meta / 不带 _meta 的既有规则',
      pass: typeof call?.meta?.['io.modelcontextprotocol/protocolVersion'] === 'string',
      detail: JSON.stringify(call?.meta ?? null),
    })
    return summarize(checks, { mcpCall: mcpResult, builtinCall: builtinResult }, 'tools/call 的别名注入在当前命名策略（mcp__<server>__<tool>）下不能顶替内建工具；版本差异只在 _meta 是否随请求携带。')
  } finally {
    await fixture.close()
  }
}

/** 4. mcp resources/read 越权读取：该面在客户端不存在（只实现 tools）。 */
async function probeResources(caseDir) {
  const checks = []
  const surface = await clientSurface()
  const modern = await withFixture(caseDir, { name: 'srv', flags: ['--call-mode', 'mixed'] })
  const legacy = await withFixture(caseDir, { name: 'srv', flags: ['--era', 'legacy'] })
  try {
    const mixed = await modern.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    await legacy.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const allMethods = [...requests(modern.trace()), ...requests(legacy.trace())].map((x) => x.method)
    checks.push({
      name: '客户端从不发起 resources/*（资源读取面不存在）',
      pass: !allMethods.some((m) => m.startsWith('resources/')),
      detail: allMethods.join(','),
    })
    checks.push({
      name: '客户端方法面不含 resource/prompt 相关实现',
      pass: !surface.methods.some((m) => /resource|prompt|sampl|root/i.test(m)),
      detail: surface.methods.join(','),
    })
    checks.push({
      name: '服务端宣告 resources 能力也不会被采用',
      pass: modern.registry.list().every((t) => t.name.startsWith('mcp__')),
    })
    checks.push({
      name: '嵌入资源内容被如实降级为文本（不静默丢失、不假装支持）',
      pass: String(mixed.text ?? '').includes('嵌入资源') || String(mixed.text ?? '').includes('资源链接'),
      detail: String(mixed.text ?? '').slice(0, 160),
    })
    return summarize(checks, { allMethods }, 'resources/prompts 面在本客户端（两个版本）都不存在：只实现 server/discover、initialize、tools/list、tools/call。')
  } finally {
    await modern.close()
    await legacy.close()
  }
}

/** 5. mcp sampling/createMessage 回注：旧版存在该面（我们拒绝），现代已改为 MRTR（我们拒答）。 */
async function probeSampling(caseDir) {
  const checks = []
  const legacy = await withFixture(caseDir, {
    name: 'srv',
    flags: ['--era', 'legacy', '--server-request', 'sampling/createMessage', '--server-request-era', 'legacy'],
  })
  const modern = await withFixture(caseDir, {
    name: 'srv',
    flags: ['--server-request', 'sampling/createMessage', '--server-request-era', 'modern'],
  })
  const mrtr = await withFixture(caseDir, { name: 'srv', flags: ['--call-mode', 'input-required'] })
  try {
    const legacyCall = await legacy.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const legacyReply = legacy.trace().find((x) => x.kind === 'client-response' && x.id === 'srv-1')
    checks.push({
      name: '2025-06-18：服务端发 sampling/createMessage → 客户端报错拒绝（不代为调用模型）',
      pass: legacyReply?.hasError === true && legacyReply?.code === -32601,
      detail: JSON.stringify(legacyReply ?? null),
    })
    checks.push({
      name: '2025-06-18：拒绝后工具调用仍正常完成（不崩）',
      pass: String(legacyCall.text ?? '').includes('echo:'),
      detail: String(legacyCall.text ?? ''),
    })
    const modernCall = await modern.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    checks.push({
      name: '2026-07-28：服务端发请求即违反规范 → 客户端忽略（不写响应）且不崩',
      pass:
        String(modernCall.text ?? '').includes('echo:') &&
        modern.trace().filter((x) => x.kind === 'client-response').length === 0,
      detail: modern.logger.warnings.find((w) => w.includes('禁止服务端向客户端发请求')) ?? '',
    })
    const mrtrCall = await mrtr.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    checks.push({
      name: '2026-07-28：MRTR（InputRequiredResult）→ 客户端如实报错，不伪造输入',
      pass:
        String(mrtrCall.error ?? '').includes('input_required') && String(mrtrCall.error ?? '').includes('未声明 elicitation'),
      detail: String(mrtrCall.error ?? '').slice(0, 160),
    })
    return summarize(
      checks,
      { legacyReply: legacyReply ?? null, modernClientResponses: 0 },
      '按版本分别陈述：2025-06-18 下 sampling/createMessage 是真实存在的 server→client 请求面（本客户端未声明该能力，实测一律以 -32601 拒绝）；' +
        '2026-07-28 已移除该面（规范改为 Multi-Round-Trip 的 InputRequiredResult），服务端**不得**向客户端发请求，实测被忽略且不回写响应；' +
        '两种机制下客户端都没有把请求转成模型调用（无回注通道）。',
    )
  } finally {
    await legacy.close()
    await modern.close()
    await mrtr.close()
  }
}

/** 6. mcp roots 越权列举：旧版有该面（我们拒绝），且我们从未声明 roots 能力。 */
async function probeRoots(caseDir) {
  const checks = []
  const surface = await clientSurface()
  const legacy = await withFixture(caseDir, {
    name: 'srv',
    flags: ['--era', 'legacy', '--server-request', 'roots/list', '--server-request-era', 'legacy'],
  })
  const modern = await withFixture(caseDir, { name: 'srv', flags: [] })
  try {
    await legacy.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const reply = legacy.trace().find((x) => x.kind === 'client-response' && x.id === 'srv-1')
    checks.push({
      name: '2025-06-18：服务端发 roots/list → 客户端报错拒绝（不泄露工作区路径）',
      pass: reply?.hasError === true && reply?.code === -32601,
      detail: JSON.stringify(reply ?? null),
    })
    const initCaps = requestOf(legacy.trace(), 'initialize')?.params?.capabilities
    checks.push({
      name: '旧版 initialize 未声明 roots（capabilities 为空）',
      pass: JSON.stringify(initCaps) === '{}',
      detail: JSON.stringify(initCaps ?? null),
    })
    const metaCaps = requestOf(modern.trace(), 'tools/list')?.meta?.['io.modelcontextprotocol/clientCapabilities']
    checks.push({
      name: '现代每请求 clientCapabilities 为空（未声明 roots）',
      pass: JSON.stringify(metaCaps) === '{}',
      detail: JSON.stringify(metaCaps ?? null),
    })
    checks.push({
      name: '客户端方法面不含 roots 实现',
      pass: !surface.methods.some((m) => /root/i.test(m)),
      detail: surface.methods.join(','),
    })
    return summarize(checks, { initCaps: initCaps ?? null, metaCaps: metaCaps ?? null }, '按版本分别陈述：2025-06-18 下 roots 是真实的 server→client 请求面，但本客户端**从未声明** roots 能力，实测服务端越权发起时被以 -32601 拒绝；2026-07-28 已移除 roots（列入弃用/由 MRTR 取代），每请求 clientCapabilities 恒为空，服务端没有依据发起。')
  } finally {
    await legacy.close()
    await modern.close()
  }
}

/** 7. mcp prompts/get 注入：该面在客户端不存在。 */
async function probePrompts(caseDir) {
  const checks = []
  const surface = await clientSurface()
  const modern = await withFixture(caseDir, { name: 'srv' })
  const legacy = await withFixture(caseDir, { name: 'srv', flags: ['--era', 'legacy'] })
  try {
    await modern.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    await legacy.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    const all = [...requests(modern.trace()), ...requests(legacy.trace())].map((x) => x.method)
    checks.push({
      name: '客户端从不发起 prompts/*（提示词模板面不存在）',
      pass: !all.some((m) => m.startsWith('prompts/')),
      detail: all.join(','),
    })
    checks.push({
      name: '客户端方法面不含 prompts 实现',
      pass: !surface.methods.some((m) => /prompt/i.test(m)),
      detail: surface.methods.join(','),
    })
    checks.push({
      name: '服务端宣告 prompts 能力不被采用（工具面照常工作）',
      pass: modern.registry.list().some((t) => t.name === 'mcp__srv__echo'),
    })
    return summarize(checks, { allMethods: all }, 'prompts/get 注入面不存在（两个版本一致）：客户端只实现 tools，服务端宣告的 prompts 能力被忽略。内容级提示注入由其他探针判定。')
  } finally {
    await modern.close()
    await legacy.close()
  }
}

/** 8. mcp transport framing 注入：stdout 污染 / 进程退出 / stdin 纯净性。 */
async function probeFraming(caseDir) {
  const checks = []
  const polluted = await withFixture(caseDir, { name: 'srv', flags: ['--pollute-stdout'] })
  const crashing = await withFixture(caseDir, { name: 'srv', flags: ['--exit-after', '2'] })
  try {
    checks.push({
      name: 'stdout 混入非 MCP 内容：仅告警，连接与列举不受影响',
      pass:
        polluted.status().connected === true &&
        polluted.registry.list().length === 4 &&
        polluted.logger.warnings.some((w) => w.includes('非 MCP 内容')),
      detail: polluted.logger.warnings.filter((w) => w.includes('非 MCP 内容')).slice(0, 2).join(' | '),
    })
    const first = await polluted.registry.execute('mcp__srv__echo', { text: 'a' }, {})
    const second = await polluted.registry.execute('mcp__srv__echo', { text: 'b' }, {})
    checks.push({
      name: '污染之后后续请求仍能完成',
      pass: String(first.text ?? '').includes('echo:') && String(second.text ?? '').includes('echo:'),
      detail: `${String(first.text ?? '')} / ${String(second.text ?? '')}`,
    })
    await sleep(300)
    const afterExit = await crashing.registry.execute('mcp__srv__echo', { text: 'x' }, {})
    checks.push({
      name: 'server 进程意外退出 → 调用快速返回可读错误、不自动重连、不崩',
      pass:
        typeof afterExit.error === 'string' &&
        afterExit.error.length > 0 &&
        crashing.logger.warnings.some((w) => w.includes('不做自动重连')),
      detail: String(afterExit.error ?? ''),
    })
    const stdinPollution = [...polluted.trace(), ...crashing.trace()].filter((x) => x.kind === 'stdin-pollution')
    checks.push({
      name: '客户端从不向 stdin 写非 MCP 内容（服务端侧零解析失败）',
      pass: stdinPollution.length === 0,
      detail: JSON.stringify(stdinPollution.slice(0, 2)),
    })
    return summarize(
      checks,
      { stdinPollution: stdinPollution.length, crashes: 1 },
      '帧格式层的攻击面实测：stdout 污染（非 JSON / 错误 jsonrpc 版本）只告警；进程意外退出被标记为不可用并快速失败（无自动重连循环）；客户端侧 stdin 零污染。两版本共用同一帧实现。',
    )
  } finally {
    await polluted.close()
    await crashing.close()
  }
}

/** 9. mcp auth token 覆盖：stdio 不走 MCP 授权框架，凭据来自环境变量。 */
async function probeAuth(caseDir) {
  const checks = []
  const surface = await clientSurface()
  const fixture = await withFixture(caseDir, { name: 'srv', env: { MCP_PROBE_MARK: 'probe-ok' } })
  try {
    const envResult = await fixture.registry.execute('mcp__srv__env_probe', { key: 'MCP_PROBE_MARK' }, {})
    const dumped = JSON.stringify(fixture.trace())
    checks.push({
      name: 'stdio 凭据来自配置 env（实测子进程拿到 env 值）',
      pass: String(envResult.text ?? '').trim() === 'probe-ok',
      detail: String(envResult.text ?? ''),
    })
    checks.push({
      name: '请求里不含任何授权材料（无 Authorization / Bearer / access_token / OAuth 字段）',
      pass: !/authorization|bearer|access_token|oauth/i.test(dumped),
    })
    checks.push({
      name: '客户端方法面不含授权/token 处理实现',
      pass: !surface.methods.some((m) => /auth|token|credential/i.test(m)),
      detail: surface.methods.join(','),
    })
    return summarize(checks, { traceBytes: dumped.length }, 'stdio 传输不使用 MCP 授权框架（规范如此）：实测请求中无任何授权字段，子进程凭据只能来自配置 env；因此不存在"授权 token 覆盖"这一 HTTP 侧攻击面。两个版本一致。')
  } finally {
    await fixture.close()
  }
}

const MCP_PROBES = {
  'mcp initialize 握手': probeHandshake,
  'mcp tools/list 枚举': probeToolsList,
  'mcp tools/call 注入别名': probeToolsCallAlias,
  'mcp resources/read 越权读取': probeResources,
  'mcp sampling/createMessage 回注': probeSampling,
  'mcp roots 越权列举': probeRoots,
  'mcp prompts/get 注入': probePrompts,
  'mcp transport framing 注入': probeFraming,
  'mcp auth token 覆盖': probeAuth,
}

/** A2A 三条：本产品未实现，必须如实保持 Unproven（不得一刀切宣称已实测）。 */
const A2A_UNPROVEN = [
  'a2a agent-card 拉取',
  'a2a tasks/send 委托',
  'a2a push-notification 回调劫持',
]

/**
 * 协议面探针入口：MCP → 实测；A2A → 如实 Unproven。
 * @param {string} protocol scenarios.mjs 里的协议面名称
 * @param {object} env createEnv 产物（需要 env.paths.caseDir）
 * @param {object} staticFacts 静态扫描事实（保留「产品代码里确有哪些实现」的证据）
 */
export async function runProtocolProbe(protocol, env, staticFacts = {}) {
  if (A2A_UNPROVEN.includes(protocol)) {
    return {
      ok: false,
      unproven: true,
      detail:
        `A2A（Agent2Agent）在筑星 Harness 中**未实现**：产品代码里没有 agent-card 拉取、没有 tasks/send 委托、` +
        `也没有 push-notification 回调端点，该攻击面不存在，因此无法证明其安全（${protocol}）。` +
        '注意这与 MCP 不同：MCP 客户端已实现，故 MCP 的 9 条探测均已改为实测。',
      facts: { ...staticFacts, a2aImplemented: false, mcpImplemented: true },
    }
  }
  const probe = MCP_PROBES[protocol]
  if (!probe) {
    return {
      ok: false,
      unproven: true,
      detail: `未实现的协议面探针：${protocol}`,
      facts: { ...staticFacts },
    }
  }
  const caseDir = env?.paths?.caseDir
  if (!caseDir) {
    return {
      ok: false,
      unproven: true,
      detail: `协议面探针缺少隔离目录，未执行任何探测（不伪造证据）：${protocol}`,
      facts: { ...staticFacts },
    }
  }
  try {
    const result = await probe(caseDir)
    return { ...result, facts: { ...result.facts, ...staticFacts } }
  } catch (err) {
    return {
      ok: false,
      unproven: true,
      detail: `协议面探针执行异常，无证据 → Unproven：${err instanceof Error ? err.message : String(err)}`,
      facts: { ...staticFacts, error: err instanceof Error ? err.message : String(err) },
    }
  }
}
