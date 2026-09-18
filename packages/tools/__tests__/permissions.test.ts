import { describe, expect, it } from 'vitest'
import { createHarness } from '@zhuxing/harness-kernel'
import { ToolRegistryImpl } from '../src/index.js'
import type { ToolRegistry } from '../src/index.js'
import { commandNameOf, matchesPathScope, checkPluginPermissions } from '../src/permissions.js'

/** 注册一个「写文件」工具。 */
function registerWriteTool(tools: ToolRegistry) {
  tools.register({
    name: 'write',
    description: '写文件',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    sandbox: { writeArg: 'path' },
    execute: (args) => ({ text: `wrote ${String(args.path)}` }),
  })
}

/** 注册一个「读文件」工具。 */
function registerReadTool(tools: ToolRegistry) {
  tools.register({
    name: 'read',
    description: '读文件',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    sandbox: { readArg: 'path' },
    execute: (args) => ({ text: `read ${String(args.path)}` }),
  })
}

/** 注册一个「执行命令」工具。 */
function registerShellTool(tools: ToolRegistry) {
  tools.register({
    name: 'shell',
    description: '执行命令',
    schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    sandbox: { commandArg: 'command' },
    execute: (args) => ({ text: `ran ${String(args.command)}` }),
  })
}

describe('插件权限清单：路径范围（fsRead / fsWrite）', () => {
  it('声明 fsWrite: ["/tmp/x"]：范围内写入放行，越界写入被拒绝且原因含路径', async () => {
    const reg = new ToolRegistryImpl()
    registerWriteTool(reg.forPlugin('p-writer', { fsWrite: ['/tmp/x'] }))

    const allowed = await reg.execute('write', { path: '/tmp/x/a.txt' }, {})
    expect(allowed.error).toBeUndefined()
    expect(allowed.text).toContain('/tmp/x/a.txt')

    const denied = await reg.execute('write', { path: '/etc/passwd' }, {})
    expect(denied.error).toBeDefined()
    expect(denied.error).toContain('fsWrite')
    expect(denied.error).toContain('/etc/passwd')
    expect(denied.text).toBeUndefined()
  })

  it('声明 fsRead: ["/data/**"]：glob 范围内放行，范围外拒绝', async () => {
    const reg = new ToolRegistryImpl()
    registerReadTool(reg.forPlugin('p-reader', { fsRead: ['/data/**'] }))

    expect((await reg.execute('read', { path: '/data/a/b.txt' }, {})).text).toBe('read /data/a/b.txt')
    const denied = await reg.execute('read', { path: '/other/b.txt' }, {})
    expect(denied.error).toContain('fsRead')
    expect(denied.error).toContain('/other/b.txt')
  })

  it('声明为空数组等价于该维度全部拒绝', async () => {
    const reg = new ToolRegistryImpl()
    registerWriteTool(reg.forPlugin('p-empty', { fsWrite: [] }))
    const denied = await reg.execute('write', { path: '/tmp/x/a.txt' }, {})
    expect(denied.error).toContain('fsWrite')
  })

  it('拒绝事件可从 tools/after-exec 审计（rejectedBy=plugin-permissions，去重不静默）', async () => {
    const reg = new ToolRegistryImpl()
    registerWriteTool(reg.forPlugin('p-writer', { fsWrite: ['/tmp/x'] }))
    const after: Array<Record<string, unknown>> = []
    const before: Array<Record<string, unknown>> = []
    const emit = async (event: string, payload: unknown) => {
      if (event === 'tools/after-exec') after.push(payload as Record<string, unknown>)
      if (event === 'tools/before-exec') before.push(payload as Record<string, unknown>)
      return true
    }
    await reg.execute('write', { path: '/etc/passwd' }, { emit, sessionId: 's1', callId: 'c1' })

    expect(before).toHaveLength(1) // 仍然先经过通用的前置拦截事件
    expect(after).toHaveLength(1)
    expect(after[0].rejectedBy).toBe('plugin-permissions')
    expect(after[0].pluginId).toBe('p-writer')
    expect(after[0].ok).toBe(false)
    expect(String((after[0].result as { error: string }).error)).toContain('/etc/passwd')
  })
})

describe('插件权限清单：命令白名单（shell）', () => {
  it('声明 shell: ["echo"]：echo hi 放行，rm -rf / 被拒绝', async () => {
    const reg = new ToolRegistryImpl()
    registerShellTool(reg.forPlugin('p-sh', { shell: ['echo'] }))

    const allowed = await reg.execute('shell', { command: 'echo hi' }, {})
    expect(allowed.error).toBeUndefined()
    expect(allowed.text).toBe('ran echo hi')

    const denied = await reg.execute('shell', { command: 'rm -rf /' }, {})
    expect(denied.error).toContain('shell')
    expect(denied.error).toContain('rm')
  })

  it('命令首词解析：忽略引号与路径，Windows 下忽略可执行扩展名', () => {
    expect(commandNameOf('  echo   hi ')).toBe('echo')
    expect(commandNameOf('"/usr/bin/node" -v')).toBe('node')
    expect(commandNameOf('/bin/ls -la')).toBe('ls')
    if (process.platform === 'win32') {
      expect(commandNameOf('C:\\Windows\\System32\\cmd.exe /c dir')).toBe('cmd')
    }
  })

  it('路径范围匹配：前缀边界不误放（/tmp/x2 不属于 /tmp/x）', () => {
    expect(matchesPathScope('/tmp/x/a.txt', '/tmp/x')).toBe(true)
    expect(matchesPathScope('/tmp/x', '/tmp/x')).toBe(true)
    expect(matchesPathScope('/tmp/x2/a.txt', '/tmp/x')).toBe(false)
    expect(matchesPathScope('/tmp/x/a.txt', '/tmp/**')).toBe(true)
  })

  it('声明 shell 但工具无 commandArg 元数据时不误判（该维度无法裁决即不裁决）', () => {
    const reason = checkPluginPermissions(
      'other',
      { name: 'other', description: '', schema: {}, execute: () => ({}) },
      { command: 'rm -rf /' },
      { shell: ['echo'] },
      'p-sh',
    )
    expect(reason).toBeUndefined()
  })
})

describe('向后兼容：未声明权限的插件行为不变', () => {
  it('直接 register（无归属）的工具不受权限约束', async () => {
    const reg = new ToolRegistryImpl()
    registerWriteTool(reg)
    const result = await reg.execute('write', { path: '/etc/passwd' }, {})
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('wrote /etc/passwd')
  })

  it('经 inject 视图注册但插件未声明 permissions：不受限（与改动前一致）', async () => {
    const reg = new ToolRegistryImpl()
    registerWriteTool(reg.forPlugin('p-plain'))
    registerShellTool(reg.forPlugin('p-plain'))
    expect((await reg.execute('write', { path: '/etc/passwd' }, {})).error).toBeUndefined()
    expect((await reg.execute('shell', { command: 'rm -rf /' }, {})).error).toBeUndefined()
  })

  it('声明了 fsWrite 的插件，其 readArg 工具不受限（未声明的维度不设限）', async () => {
    const reg = new ToolRegistryImpl()
    registerReadTool(reg.forPlugin('p-partial', { fsWrite: ['/tmp/x'] }))
    const result = await reg.execute('read', { path: '/etc/passwd' }, {})
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('read /etc/passwd')
  })
})

describe('权限声明经 ctx.inject("tools") 生效（内核绑定插件身份）', () => {
  it('插件声明的 permissions 随记录与工具归属传递到执行边界', async () => {
    const app = createHarness({ logLevel: 'error' })
    try {
      const reg = new ToolRegistryImpl()
      await app.mount({ name: 'harness-tools', description: '工具注册表', apply: (ctx) => ctx.provide('tools', reg) })
      await app.mount({
        name: 'p-declared',
        description: '声明了权限的插件',
        inject: ['tools'],
        permissions: { fsWrite: ['/tmp/x'] },
        apply: (ctx) => {
          registerWriteTool(ctx.inject<ToolRegistry>('tools'))
        },
      })

      expect(app.pluginManager.get('p-declared')?.permissions).toEqual({ fsWrite: ['/tmp/x'] })
      const tools = app.services.get<ToolRegistry>('tools')!
      expect((await tools.execute('write', { path: '/tmp/x/ok.txt' }, {})).error).toBeUndefined()
      expect((await tools.execute('write', { path: '/etc/passwd' }, {})).error).toContain('/etc/passwd')
    } finally {
      await app.pluginManager.disposeAll()
    }
  })

  it('卸载插件后工具归属随之清理（热重载不残留陈旧权限）', async () => {
    const app = createHarness({ logLevel: 'error' })
    try {
      const reg = new ToolRegistryImpl()
      await app.mount({ name: 'harness-tools', apply: (ctx) => ctx.provide('tools', reg) })
      await app.mount({
        name: 'p-temp',
        inject: ['tools'],
        permissions: { fsWrite: [] },
        apply: (ctx) => {
          const tools = ctx.inject<ToolRegistry>('tools')
          ctx.effect(
            tools.register({
              name: 'temp-write',
              description: '',
              schema: {},
              sandbox: { writeArg: 'path' },
              execute: () => ({ text: 'ok' }),
            }),
          )
        },
      })
      expect((await reg.execute('temp-write', { path: '/tmp/x/a.txt' }, {})).error).toContain('fsWrite')
      await app.pluginManager.unmount('p-temp')
      expect(reg.get('temp-write')).toBeUndefined()
      // 重新注册同名工具且不带权限时不被旧归属影响
      reg.register({ name: 'temp-write', description: '', schema: {}, execute: () => ({ text: 'ok' }) })
      expect((await reg.execute('temp-write', { path: '/tmp/x/a.txt' }, {})).error).toBeUndefined()
    } finally {
      await app.pluginManager.disposeAll()
    }
  })
})
