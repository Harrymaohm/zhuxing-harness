import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { createHarness } from '@zhuxing/harness-kernel'
import { loadPluginModule } from '@zhuxing/harness-config'
import { baseBundlePlugins } from '@zhuxing/harness-cli'
import type { SessionService } from '@zhuxing/harness-session'
import type { ToolRegistry } from '@zhuxing/harness-tools'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function makeFakeProvider(): ChatProvider & { calls: number } {
  let calls = 0
  return {
    name: 'fake',
    get calls() {
      return calls
    },
    async chat(_messages: ChatMessage[]): Promise<ChatResult> {
      calls++
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'c1', name: 'hello', arguments: '{"name":"集成测试"}' }],
          finishReason: 'tool_calls',
        }
      }
      return { content: '闭环跑通：你好，集成测试！', toolCalls: [], finishReason: 'stop' }
    },
  }
}

describe('端到端：base bundle + 外部插件 + 模型闭环', () => {
  it('hello-plugin 注册的工具可被 Agent 调用，会话日志可回放', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const provider = makeFakeProvider()
    const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-e2e-'))

    // 1. 挂载基础 bundle（沙箱/会话/工具/模型/循环），llm 注入假 provider
    for (const def of baseBundlePlugins({
      apiKey: 'sk-test',
      model: 'fake-model',
      workspace,
      level: 'workspace-write',
    })) {
      await app.mount(def, { config: def.name === 'harness-llm' ? { provider } : undefined })
    }

    // 2. 通过配置加载器挂载外部插件（.ts 转译）
    const helloMod = await loadPluginModule(join(repoRoot, 'examples', 'hello-plugin', 'src', 'index.ts'))
    await app.mount(helloMod)
    expect(app.pluginManager.get('hello-plugin')).toBeDefined()

    // 3. 运行任务
    const agent = app.pluginManager.get('harness-agent')!.ctx.inject<{ run: (t: string) => Promise<never> }>('agent')
    const result = (await agent.run('用 hello 工具打个招呼')) as import('@zhuxing/harness-agent').AgentResult

    expect(provider.calls).toBe(2)
    expect(result.finishedReason).toBe('stop')
    expect(result.content).toContain('闭环跑通')

    // 4. 会话轨迹可追溯：含 user / assistant / tool(hello) / assistant
    const sessionService = app.pluginManager.get('harness-session')!.ctx.inject<SessionService>('sessionService')
    const session = await sessionService.get(result.sessionId)
    const events = await session.events()
    expect(events.map((e) => e.type)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect((events[2].payload as { name: string }).name).toBe('hello')

    // 5. 级联卸载验证：卸载 hello-plugin 不拖垮基础栈
    await app.unmount('hello-plugin')
    expect(app.pluginManager.stateOf('hello-plugin')).toBe('disposed')
    expect(app.pluginManager.get('harness-agent')).toBeDefined()

    await app.dispose()
  })

  it('read-only 沙箱下写文件工具被拒绝', async () => {
    const app = createHarness({ logLevel: 'warn' })
    const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-e2e-'))
    for (const def of baseBundlePlugins({
      apiKey: 'sk-test',
      model: 'fake-model',
      workspace,
      level: 'read-only',
    })) {
      await app.mount(def, { config: def.name === 'harness-llm' ? { provider: makeFakeProvider() } : undefined })
    }
    // 工具管道 + 沙箱协作：写文件被 read-only 策略拒绝
    const tools = app.pluginManager.get('harness-tools')!.ctx.inject<ToolRegistry>('tools')
    const sandbox = app.pluginManager.get('harness-sandbox')!.ctx.inject('sandbox')
    const denied = await tools.execute('write_file', { path: 'x.txt', content: 'hack' }, { sandbox })
    expect(denied.error).toContain('read-only')
    await app.dispose()
  })
})
