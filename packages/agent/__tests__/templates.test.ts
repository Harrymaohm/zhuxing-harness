/**
 * G-code 模板沉淀/复用层测试：
 * - 纯函数：实例化、参数引用对齐、目录渲染、失败禁用；
 * - PlanAgent 集成：首次 compile+generalize 沉淀 → 二次仅一次「极小输出」select 即完成执行。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import { MemorySessionStore, SessionImpl } from '@zhuxing/harness-session'
import { ToolRegistryImpl } from '@zhuxing/harness-tools'
import { PlanAgent } from '../src/plan.js'
import {
  MemoryTemplateStore,
  instantiateTemplate,
  isTemplateDisabled,
  normalizeTemplate,
  templateCatalog,
  type GTemplate,
} from '../src/templates.js'
import type { GPlan } from '../src/gcode.js'

/** 按 system 提示词角色分流的假模型（编译器 / 选择器 / 固化师 / 常规兜底）。 */
function makeProvider(handlers: { compile?: string; select?: string; generalize?: string; fallback?: string }) {
  const counts = { compile: 0, select: 0, generalize: 0, loop: 0 }
  const provider: ChatProvider = {
    name: 'fake',
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      const sys = typeof messages[0]?.content === 'string' ? messages[0].content : ''
      let role: 'compile' | 'select' | 'generalize' | 'loop' = 'loop'
      if (sys.includes('任务编译器')) role = 'compile'
      else if (sys.includes('复用调度器')) role = 'select'
      else if (sys.includes('流程固化师')) role = 'generalize'
      counts[role] += 1
      const content = role === 'loop' ? handlers.fallback ?? '常规答复' : handlers[role] ?? '{}'
      return { content, toolCalls: [], finishReason: 'stop' }
    },
  }
  return { provider, counts }
}

async function makeSession() {
  const store = new MemorySessionStore()
  return new SessionImpl(store, await store.createSession())
}

function makeTools() {
  const tools = new ToolRegistryImpl()
  tools.register({
    name: 'read',
    description: '读文件',
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: (args) => ({ text: `<${String(args.path)}>` }),
  })
  return tools
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

const TEMPLATE_RAW = JSON.stringify({
  id: 'read-two-files',
  summary: '读取两个文件并汇总',
  whenToUse: '用户要求读取或对比两个文件的内容',
  params: [
    { name: 'pa', desc: '第一个文件路径', required: true },
    { name: 'pb', desc: '第二个文件路径', required: true },
  ],
  plan: {
    version: 1,
    goal: '读两个文件',
    nodes: [
      { id: 'n1', op: 'tool', tool: 'read', args: { path: '{{params.pa}}' } },
      { id: 'n2', op: 'tool', tool: 'read', args: { path: '{{params.pb}}' } },
      { id: 'd', op: 'aggregate', dependsOn: ['n1', 'n2'], template: 'A={{n1}} B={{n2}}' },
    ],
    deliver: 'd',
  },
})

function makeTemplate(overrides: Partial<GTemplate> = {}): GTemplate {
  const t = normalizeTemplate(JSON.parse(TEMPLATE_RAW))!
  return { ...t, ...overrides }
}

describe('模板纯函数', () => {
  it('instantiateTemplate：填参成功；缺必填/引用未声明/残留引用 → null', () => {
    const t = makeTemplate()
    const plan = instantiateTemplate(t, { pa: 'c.txt', pb: 'd.txt' })
    expect(plan).not.toBeNull()
    const nodes = plan!.nodes as unknown as Array<Record<string, unknown>>
    expect((nodes[0].args as Record<string, unknown>).path).toBe('c.txt')
    // {{n1}} 节点引用不受影响
    expect(nodes[2].template).toBe('A={{n1}} B={{n2}}')

    expect(instantiateTemplate(t, { pa: 'c.txt' })).toBeNull() // 缺必填 pb
    expect(instantiateTemplate(t, { pa: '', pb: 'd.txt' })).toBeNull() // 空值不算提供
    // 未声明的引用
    const bad = makeTemplate()
    const badNodes = bad.plan.nodes as unknown as Array<Record<string, unknown>>
    ;(badNodes[0].args as Record<string, unknown>).path = '{{params.pz}}'
    expect(instantiateTemplate(bad, { pa: 'a', pb: 'b', pz: 'z' })).toBeNull()
    // 数组元素里的残留引用（实例化不覆盖非字符串顶层位置）→ 拒绝复用
    const leaky = makeTemplate()
    const leakyNodes = leaky.plan.nodes as unknown as Array<Record<string, unknown>>
    ;(leakyNodes[0].args as Record<string, unknown>).list = ['{{params.pa}}']
    expect(instantiateTemplate(leaky, { pa: 'a', pb: 'b' })).toBeNull()
  })

  it('normalizeTemplate：引用必须有声明；未引用的声明剔除；id:null 拒绝', () => {
    expect(normalizeTemplate({ id: null })).toBeNull()
    // 声明了 pc 但 plan 未引用 → 剔除，params 只剩 pa/pb
    const withExtra = JSON.parse(TEMPLATE_RAW)
    withExtra.params.push({ name: 'pc', desc: '多余', required: true })
    const t = normalizeTemplate(withExtra)!
    expect(t.params.map((p) => p.name).sort()).toEqual(['pa', 'pb'])
    // 引用了未声明参数 → null
    const missing = JSON.parse(TEMPLATE_RAW)
    missing.params = [{ name: 'pa', desc: 'x' }]
    expect(normalizeTemplate(missing)).toBeNull()
    expect(t.successCount).toBe(1)
    expect(t.failCount).toBe(0)
  })

  it('templateCatalog 只含摘要不含计划全文', () => {
    const cat = templateCatalog([makeTemplate()])
    expect(cat).toContain('read-two-files')
    expect(cat).toContain('第一个文件路径')
    expect(cat).not.toContain('aggregate')
  })

  it('isTemplateDisabled：失败达到阈值且多于成功才下线', () => {
    expect(isTemplateDisabled(makeTemplate({ failCount: 2, successCount: 0 }))).toBe(false)
    expect(isTemplateDisabled(makeTemplate({ failCount: 3, successCount: 5 }))).toBe(false)
    expect(isTemplateDisabled(makeTemplate({ failCount: 3, successCount: 0 }))).toBe(true)
  })
})

describe('PlanAgent 模板沉淀与复用', () => {
  it('首次 compile+generalize 沉淀模板；二次仅一次极小输出即完成执行', async () => {
    const store = new MemoryTemplateStore()
    const fake = makeProvider({ compile: PLAN_OK, generalize: TEMPLATE_RAW, select: '{"template":"read-two-files","params":{"pa":"c.txt","pb":"d.txt"}}' })
    const agent = new PlanAgent({ llm: fake.provider, tools: makeTools(), session: await makeSession() }, { templates: store })

    // 第一次：模板库为空 → 选择路径零调用；编译 + 执行成功后泛化沉淀
    const r1 = await agent.run('读 a 和 b')
    expect(r1.content).toBe('A=<a.txt> B=<b.txt>')
    expect(fake.counts).toEqual({ compile: 1, select: 0, generalize: 1, loop: 0 })
    expect(r1.plan?.templateId).toBeUndefined()
    const saved = await store.list()
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe('read-two-files')

    // 第二次（同类请求）：只花一次「目录选书」调用，不再全量编译
    const r2 = await agent.run('读 c.txt 和 d.txt')
    expect(r2.content).toBe('A=<c.txt> B=<d.txt>')
    expect(fake.counts).toEqual({ compile: 1, select: 1, generalize: 1, loop: 0 })
    expect(r2.plan?.templateId).toBe('read-two-files')
    expect(r2.plan?.compiled).toBe(false)
    // 成功计数：沉淀 1 + 复用成功 1
    expect((await store.list())[0].successCount).toBe(2)
  })

  it('选择器返回 null → 静默回全量编译（不算失败）', async () => {
    const store = new MemoryTemplateStore([makeTemplate()])
    const fake = makeProvider({ select: '{"template":null}', compile: PLAN_OK, generalize: '{"id":null}' })
    const agent = new PlanAgent({ llm: fake.provider, tools: makeTools(), session: await makeSession() }, { templates: store })
    const r = await agent.run('帮我想个周末活动方案')
    expect(fake.counts.select).toBe(1)
    expect(fake.counts.compile).toBe(1)
    expect(r.plan?.fallback).toBe(false)
    expect(r.plan?.templateId).toBeUndefined()
    // 模型判定不可复用（id:null）→ 不新增模板
    expect((await store.list())[0].id).toBe('read-two-files')
  })

  it('复用执行失败 → 记 failCount 并回退 AgentLoop 兜底', async () => {
    const tools = new ToolRegistryImpl()
    tools.register({ name: 'read', description: '读文件', schema: { type: 'object' }, execute: () => ({ error: '文件不存在' }) })
    const store = new MemoryTemplateStore([makeTemplate()])
    const fake = makeProvider({
      select: '{"template":"read-two-files","params":{"pa":"x.txt","pb":"y.txt"}}',
      fallback: '兜底完成',
    })
    const agent = new PlanAgent({ llm: fake.provider, tools, session: await makeSession() }, { templates: store })
    const r = await agent.run('读 x 和 y')
    expect(r.plan?.fallback).toBe(true)
    expect(r.plan?.templateId).toBe('read-two-files')
    expect(r.content).toBe('兜底完成')
    expect((await store.list())[0].failCount).toBe(1)
  })

  it('反复失败的模板被自动禁用：不再进入目录（选择零调用）', async () => {
    const disabled = makeTemplate({ failCount: 3, successCount: 0 })
    const store = new MemoryTemplateStore([disabled])
    const fake = makeProvider({ compile: PLAN_OK, generalize: '{"id":null}' })
    const agent = new PlanAgent({ llm: fake.provider, tools: makeTools(), session: await makeSession() }, { templates: store })
    const r = await agent.run('读 a 和 b')
    // 目录里没有任何可用模板 → 跳过选择（零调用），直接全量编译
    expect(fake.counts.select).toBe(0)
    expect(fake.counts.compile).toBe(1)
    expect(r.plan?.fallback).toBe(false)
  })

  it('节点数未达沉淀门槛 → 不泛化（零额外调用）', async () => {
    const store = new MemoryTemplateStore()
    const smallPlan = JSON.stringify({
      version: 1,
      goal: '读一个文件',
      nodes: [{ id: 'n1', op: 'tool', tool: 'read', args: { path: 'a.txt' } }],
      deliver: 'n1',
    })
    const fake = makeProvider({ compile: smallPlan })
    const agent = new PlanAgent({ llm: fake.provider, tools: makeTools(), session: await makeSession() }, { templates: store })
    const r = await agent.run('读 a')
    expect(r.content).toBe('<a.txt>')
    expect(fake.counts.generalize).toBe(0)
    expect(await store.list()).toHaveLength(0)
  })

  it('未配置模板库时行为与纯编译闭环一致（零模板调用）', async () => {
    const fake = makeProvider({ compile: PLAN_OK })
    const agent = new PlanAgent({ llm: fake.provider, tools: makeTools(), session: await makeSession() })
    const r = await agent.run('读 a 和 b')
    expect(fake.counts).toEqual({ compile: 1, select: 0, generalize: 0, loop: 0 })
    expect(r.plan?.templateId).toBeUndefined()
    const plan = r.plan as unknown as Record<string, unknown>
    expect('templateId' in (r.plan ?? {})).toBe(true)
    expect(plan.templateId).toBeUndefined()
  })
})

describe('FileTemplateStore 持久化语义（内存版对齐验证）', () => {
  it('save 为 upsert：同 id 合并计数、保留最早 createdAt', async () => {
    const store = new MemoryTemplateStore()
    const t1 = makeTemplate()
    await store.save(t1)
    const t2: GTemplate = { ...makeTemplate(), successCount: 2, updatedAt: Date.now() + 10 }
    await store.save(t2)
    const items = await store.list()
    expect(items).toHaveLength(1)
    expect(items[0].successCount).toBe(t1.successCount + t2.successCount)
    expect(items[0].createdAt).toBe(t1.createdAt)
  })

  it('instantiate 后 plan 与原模板不共享引用（不污染库内数据）', () => {
    const t = makeTemplate()
    const plan = instantiateTemplate(t, { pa: 'z1', pb: 'z2' }) as GPlan
    ;((plan.nodes[0] as unknown as { args: Record<string, unknown> }).args as Record<string, unknown>).path = 'MUTATED'
    const again = instantiateTemplate(t, { pa: 'z1', pb: 'z2' })!
    expect(((again.nodes[0] as unknown as { args: Record<string, unknown> }).args as Record<string, unknown>).path).toBe('z1')
  })
})
