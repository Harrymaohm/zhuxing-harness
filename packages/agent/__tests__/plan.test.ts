import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import { PlanAgent, compactHistory } from '../src/plan.js'
import { validatePlan, extractPlanJson, resolveTemplate, topoLayers } from '../src/gcode.js'

/** 脚本化假模型：按调用次序返回。可标记某次为「编译器」调用（system 含 G-code 目录）。 */
function makeProvider(script: Array<{ content: string; toolCalls?: ChatResult['toolCalls']; finishReason: string }>) {
  let calls = 0
  const compilerCalls = { n: 0 }
  return {
    provider: {
      name: 'fake',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        const isCompile = typeof messages[0]?.content === 'string' && messages[0].content.includes('G-code')
        if (isCompile) compilerCalls.n += 1
        const step = script[Math.min(calls, script.length - 1)]
        calls++
        return { content: step.content, toolCalls: step.toolCalls ?? [], finishReason: step.finishReason }
      },
    } satisfies ChatProvider,
    get calls() {
      return calls
    },
    compilerCalls,
  }
}

async function makeSession() {
  const store = new MemorySessionStore()
  return new SessionImpl(store, await store.createSession())
}

const PLAN_OK = JSON.stringify({
  version: 1,
  goal: '读两个文件',
  nodes: [
    { id: 'n1', op: 'tool', tool: 'read', args: { path: 'a.txt' } },
    { id: 'n2', op: 'tool', tool: 'read', args: { path: 'b.txt' } },
    { id: 'd', op: 'aggregate', dependsOn: ['n1', 'n2'], template: 'A={{n1}} B={{n2}}' },
  ],
  deliver: 'd',
})

describe('G-code 编译执行最小闭环', () => {
  it('编译一次 + 代码确定性执行（大模型不参与逐步决策）', async () => {
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'read',
      description: '读文件',
      schema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: (args) => ({ text: `<${String(args.path)}>` }),
    })
    const fake = makeProvider([{ content: PLAN_OK, finishReason: 'stop' }])
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() })
    const result = await agent.run('读 a 和 b')

    // 关键断言：全程只调用模型 1 次（编译），执行 3 个节点零模型
    expect(fake.compilerCalls.n).toBe(1)
    expect(fake.calls).toBe(1)
    expect(result.finishedReason).toBe('stop')
    expect(result.content).toBe('A=<a.txt> B=<b.txt>')
    expect(result.plan?.compiled).toBe(true)
    expect(result.plan?.fallback).toBe(false)
  })

  it('并行执行无依赖节点，聚合节点按序收敛', async () => {
    const tools = new ToolRegistryImpl()
    const order: string[] = []
    tools.register({
      name: 'slow',
      description: '耗时工具',
      schema: { type: 'object' },
      execute: async (args) => {
        order.push(`start:${String(args.id)}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end:${String(args.id)}`)
        return { text: String(args.id) }
      },
    })
    const plan = JSON.stringify({
      version: 1,
      goal: '并行',
      nodes: [
        { id: 'x', op: 'tool', tool: 'slow', args: { id: 'x' } },
        { id: 'y', op: 'tool', tool: 'slow', args: { id: 'y' } },
      ],
      deliver: 'x',
    })
    const fake = makeProvider([{ content: plan, finishReason: 'stop' }])
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() })
    const result = await agent.run('并行执行')
    expect(result.content).toBe('x')
    // 两个 start 都早于任一 end → 证明确实并行（同层并发）
    expect(order.indexOf('start:y')).toBeLessThan(order.indexOf('end:x'))
  })

  it('工具失败：retry 自愈；仍失败则以错误码回退 AgentLoop 兜底', async () => {
    const tools = new ToolRegistryImpl()
    let hits = 0
    tools.register({
      name: 'flaky',
      description: '总是失败的工具',
      schema: { type: 'object' },
      execute: () => {
        hits++
        return { error: '磁盘写满' }
      },
    })
    const plan = JSON.stringify({
      version: 1,
      goal: '写文件',
      nodes: [{ id: 'w', op: 'tool', tool: 'flaky', retry: 1 }],
      deliver: 'w',
    })
    // 第 1 次=编译；后续为回退后 AgentLoop 的模型调用，直接给最终答复
    const fake = makeProvider([
      { content: plan, finishReason: 'stop' },
      { content: '兜底完成', toolCalls: [], finishReason: 'stop' },
    ])
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() })
    const result = await agent.run('写文件')
    // retry=1 → 执行 2 次仍失败
    expect(hits).toBe(2)
    expect(result.plan?.fallback).toBe(true)
    expect(result.plan?.failure?.errorCode).toBe('TOOL_FAILED')
    expect(result.content).toBe('兜底完成')
  })

  it('编译器输出非法 JSON → 回退常规 AgentLoop', async () => {
    const tools = new ToolRegistryImpl()
    const fake = makeProvider([
      { content: '抱歉，我无法编译这个任务', finishReason: 'stop' },
      { content: '常规答复', toolCalls: [], finishReason: 'stop' },
    ])
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() })
    const result = await agent.run('闲聊')
    expect(result.plan?.fallback).toBe(true)
    expect(result.plan?.failure?.errorCode).toBe('PLAN_UNPARSEABLE')
    expect(result.content).toBe('常规答复')
  })

  it('model 节点：定点单次调用，产出交付内容', async () => {
    const tools = new ToolRegistryImpl()
    tools.register({
      name: 'fetch',
      description: '取数据',
      schema: { type: 'object' },
      execute: () => ({ text: '原始数据123' }),
    })
    const plan = JSON.stringify({
      version: 1,
      goal: '总结',
      nodes: [
        { id: 'r', op: 'tool', tool: 'fetch', args: {} },
        { id: 'd', op: 'model', dependsOn: ['r'], prompt: '总结：{{r}}', model: 'flash-non-thinking', output: 'text' },
      ],
      deliver: 'd',
    })
    const fake = makeProvider([
      { content: plan, finishReason: 'stop' },
      { content: '这是数据摘要。', finishReason: 'stop' },
    ])
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() })
    const result = await agent.run('取数并总结')
    // 编译 1 次 + model 节点定点 1 次 = 2，工具节点零模型
    expect(fake.calls).toBe(2)
    expect(result.content).toBe('这是数据摘要。')
    expect(result.plan?.fallback).toBe(false)
  })
})

describe('G-code 工具函数', () => {
  it('validatePlan 拦截未知工具与环', () => {
    const errs = validatePlan({ version: 1, goal: 'g', deliver: 'a', nodes: [{ id: 'a', op: 'tool', tool: 'nope' }] }, new Set(['ok']))
    expect(errs.some((e) => e.includes('未注册工具'))).toBe(true)
    const cyc = validatePlan(
      {
        version: 1,
        goal: 'g',
        deliver: 'a',
        nodes: [
          { id: 'a', op: 'tool', tool: 'ok', dependsOn: ['b'] },
          { id: 'b', op: 'tool', tool: 'ok', dependsOn: ['a'] },
        ],
      },
      new Set(['ok']),
    )
    expect(cyc.some((e) => e.includes('环'))).toBe(true)
  })

  it('extractPlanJson 容忍围栏与前后杂文', () => {
    const parsed = extractPlanJson('好的：\n```json\n{"version":1}\n```\n希望有用')
    expect(parsed).toEqual({ version: 1 })
  })

  it('resolveTemplate 未解析引用返回 null', () => {
    expect(resolveTemplate('{{a}}-{{b}}', { a: '1', b: '2' })).toBe('1-2')
    expect(resolveTemplate('{{a}}-{{miss}}', { a: '1' })).toBeNull()
  })

  it('topoLayers 分层', () => {
    const layers = topoLayers([
      { id: 'c', op: 'aggregate', template: '', dependsOn: ['a', 'b'] },
      { id: 'a', op: 'tool', tool: 't' },
      { id: 'b', op: 'tool', tool: 't' },
    ])
    expect(layers.length).toBe(2)
    expect(layers[0].map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(layers[1][0].id).toBe('c')
  })
})

describe('compactHistory（编译用紧凑历史）', () => {
  it('只保留最近 user/assistant 文本、剔除工具噪音、按 maxChars 截断', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '第一条请求' },
      { role: 'assistant', content: 'x'.repeat(500) },
      { role: 'tool', content: '超长的工具结果噪音', toolCallId: 't1' },
      { role: 'user', content: '' },
      { role: 'assistant', content: '好的' },
    ]
    const out = compactHistory(history, 3, 100)
    expect(out.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
    // 空 user 文本被过滤
    expect(out.some((m) => !String(m.content).trim())).toBe(false)
    // 长 assistant 截断到 maxChars + 省略号
    const truncated = out.find((m) => String(m.content).endsWith('…'))
    expect(truncated).toBeTruthy()
    expect((truncated?.content ?? '').length).toBeLessThanOrEqual(101)
    // 保留条数不超过 keep
    expect(compactHistory(history, 1).length).toBeLessThanOrEqual(1)
    expect(compactHistory(undefined)).toEqual([])
    expect(compactHistory([])).toEqual([])
  })
})
