import { mkdtempSync, writeFileSync } from 'node:fs'
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
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      calls++
      const sys = typeof messages[0]?.content === 'string' ? messages[0].content : ''
      // base bundle 默认注入指令精炼器：测试桩显式 SKIP，保持主流程语义不变
      if (sys.includes('任务指令精炼器')) {
        return { content: 'SKIP：固定测试桩不拆解', toolCalls: [], finishReason: 'stop' }
      }
      // 目标校验器调用：直接放行，避免触发补做循环
      if (sys.includes('任务完成度校验器')) {
        return { content: 'OK', toolCalls: [], finishReason: 'stop' }
      }
      // 主执行器：工具结果回填后给出最终答复，否则先调用 hello 工具
      if (messages.some((m) => m.role === 'tool')) {
        return { content: '闭环跑通：你好，集成测试！', toolCalls: [], finishReason: 'stop' }
      }
      return {
        content: '',
        toolCalls: [{ id: 'c1', name: 'hello', arguments: '{"name":"集成测试"}' }],
        finishReason: 'tool_calls',
      }
    },
  }
}

/** 记录每次实际发给模型的 messages，用于断言「动态上下文是否真的注入了」。 */
function makeCapturingProvider(): ChatProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return {
    name: 'capture',
    seen,
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      seen.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[])
      return { content: '好的', toolCalls: [], finishReason: 'stop' }
    },
  }
}

/** 把一次请求的 messages 拍平成纯文本，便于整体包含性断言。 */
function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
    .join('\n')
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

    // 1 次指令精炼（SKIP）+ 1 次工具调用 + 1 次最终答复 + 1 次目标校验
    expect(provider.calls).toBe(4)
    expect(result.finishedReason).toBe('stop')
    expect(result.content).toContain('闭环跑通')

    // 4. 会话轨迹可追溯：含 system(精炼SKIP) / user / assistant / tool(hello) / assistant
    const sessionService = app.pluginManager.get('harness-session')!.ctx.inject<SessionService>('sessionService')
    const session = await sessionService.get(result.sessionId)
    const events = await session.events()
    expect(events.map((e) => e.type)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant'])
    expect((events[3].payload as { name: string }).name).toBe('hello')

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
    const sandbox = app.pluginManager.get('harness-sandbox')!.ctx.inject<import('@zhuxing/harness-sandbox').Sandbox>('sandbox')
    const denied = await tools.execute('write_file', { path: 'x.txt', content: 'hack' }, { sandbox })
    expect(denied.error).toContain('read-only')
    await app.dispose()
  })

  it('动态上下文真正注入 # Environment 工作区画像（缺 await 会退化成 [object Promise]）', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'zhuxing-env-'))
    writeFileSync(
      join(workspace, 'AGENTS.md'),
      '# 工程约定\nE2E-CONVENTION-MARKER：交付前必须运行 pnpm run verify\n',
      'utf8',
    )
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'env-demo', private: true, scripts: { verify: 'node -e ""' } }),
      'utf8',
    )

    const app = createHarness({ logLevel: 'warn' })
    const provider = makeCapturingProvider()
    for (const def of baseBundlePlugins({
      apiKey: 'sk-test',
      model: 'fake-model',
      workspace,
      level: 'workspace-write',
      // 隔离记忆库，避免污染生产记忆
      memoryPath: join(workspace, 'memories.json'),
      // 无工具调用的简单任务不需要目标校验，省一次模型调用
      verifyGoal: async () => ({ ok: true }),
    })) {
      await app.mount(def, { config: def.name === 'harness-llm' ? { provider } : undefined })
    }

    const agent = app.pluginManager.get('harness-agent')!.ctx.inject<{ run: (t: string) => Promise<never> }>('agent')
    await agent.run('只回一句话即可')

    const text = flattenMessages(provider.seen.flat())
    // 环境索引块确实进了发给模型的 messages
    expect(text).toContain('# Environment')
    // 约定文件全文与工作区画像可用
    expect(text).toContain('E2E-CONVENTION-MARKER')
    expect(text).toContain('仓库既有校验命令')
    expect(text).toContain('pnpm run verify')
    // 工作区路径可见（用末段目录名做分隔符无关断言）
    expect(text).toContain(workspace.split(/[\\/]/).pop()!)
    // 关键回归点：整块绝不能退化成 Promise 的字符串化
    expect(text).not.toContain('[object Promise]')

    await app.dispose()
  })
})
