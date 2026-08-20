import { describe, expect, it } from 'vitest'
import { createSandbox } from '@zhuxing/harness-sandbox'
import { ToolRegistryImpl } from '../src/index.js'

describe('工具注册表', () => {
  it('注册、查询、去重', () => {
    const reg = new ToolRegistryImpl()
    reg.register({ name: 'a', description: 'A', schema: {}, execute: () => ({ text: 'ok' }) })
    expect(reg.get('a')).toBeDefined()
    expect(reg.list()).toHaveLength(1)
    expect(() => reg.register({ name: 'a', description: '', schema: {}, execute: () => ({}) })).toThrow(/已注册/)
    reg.unregister('a')
    expect(reg.get('a')).toBeUndefined()
  })

  it('register 返回注销函数（支持 ctx.effect 生命周期绑定）', () => {
    const reg = new ToolRegistryImpl()
    const dispose = reg.register({ name: 'temp', description: '', schema: {}, execute: () => ({ text: 'ok' }) })
    expect(reg.get('temp')).toBeDefined()
    dispose()
    expect(reg.get('temp')).toBeUndefined()
  })

  it('toChatTools 转换为模型可见格式', () => {
    const reg = new ToolRegistryImpl()
    reg.register({ name: 'a', description: 'A', schema: { type: 'object' }, execute: () => ({}) })
    const chatTools = reg.toChatTools()
    expect(chatTools).toEqual([{ name: 'a', description: 'A', schema: { type: 'object' } }])
  })
})

describe('执行管道', () => {
  it('超时返回错误', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 'slow',
      description: '',
      schema: {},
      execute: () => new Promise((r) => setTimeout(() => r({ text: 'x' }), 200)),
    })
    const result = await reg.execute('slow', {}, {}, { timeoutMs: 50 })
    expect(result.error).toContain('超时')
  })

  it('失败重试后成功', async () => {
    let n = 0
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 'flaky',
      description: '',
      schema: {},
      execute: () => {
        n++
        if (n < 2) throw new Error('boom')
        return { text: 'ok' }
      },
    })
    const result = await reg.execute('flaky', {}, {}, { retries: 1 })
    expect(result.text).toBe('ok')
    expect(n).toBe(2)
  })

  it('沙箱守卫：read-only 拒绝写类命令', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 'shell',
      description: '',
      schema: {},
      sandbox: { commandArg: 'command' },
      execute: () => ({ text: 'run' }),
    })
    const sandbox = createSandbox({ level: 'read-only', workspace: process.cwd() })
    const result = await reg.execute('shell', { command: 'rm -rf /' }, { sandbox })
    expect(result.error).toContain('read-only')
  })

  it('沙箱守卫：workspace-write 允许工作区内写路径', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({
      name: 'write',
      description: '',
      schema: {},
      sandbox: { writeArg: 'path' },
      execute: () => ({ text: 'ok' }),
    })
    const ws = process.cwd()
    const sandbox = createSandbox({ level: 'workspace-write', workspace: ws })
    const ok = await reg.execute('write', { path: `${ws}/a.txt` }, { sandbox })
    expect(ok.text).toBe('ok')
    const denied = await reg.execute('write', { path: 'C:/outside/x.txt' }, { sandbox })
    expect(denied.error).toContain('工作区外')
  })

  it('tools/before-exec 返回 false 可拦截', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({ name: 't', description: '', schema: {}, execute: () => ({ text: 'ok' }) })
    const emit = async (event: string) => (event === 'tools/before-exec' ? false : true)
    const result = await reg.execute('t', {}, { emit })
    expect(result.error).toContain('拦截')
  })

  it('tools/after-exec 事件携带结果', async () => {
    const reg = new ToolRegistryImpl()
    reg.register({ name: 't', description: '', schema: {}, execute: () => ({ text: 'done' }) })
    const seen: string[] = []
    const emit = async (event: string, payload: unknown) => {
      if (event === 'tools/after-exec') seen.push((payload as { result: { text: string } }).result.text)
      return true
    }
    await reg.execute('t', {}, { emit })
    expect(seen).toEqual(['done'])
  })
})
