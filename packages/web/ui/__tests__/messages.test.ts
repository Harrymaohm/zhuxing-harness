// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { THINKING_STEP_BUDGET, capStepThinking, rebuildMessages, summarize } from '../src/lib/messages'

/** 稳定 id 生成器（避免断言依赖全局计数）。 */
function idGen() {
  let n = 0
  return () => `m${++n}`
}

describe('capStepThinking', () => {
  it('未超预算时原样返回', () => {
    const text = 'a'.repeat(THINKING_STEP_BUDGET)
    expect(capStepThinking(text)).toBe(text)
    expect(capStepThinking('短思考')).toBe('短思考')
  })

  it('超预算时截断并标注省略量', () => {
    const out = capStepThinking('a'.repeat(THINKING_STEP_BUDGET + 250))
    expect(out.startsWith('a'.repeat(100))).toBe(true)
    expect(out).toContain('思考过长')
    expect(out).toContain('已省略 250 字')
    expect(out.length).toBeLessThan(THINKING_STEP_BUDGET + 60)
  })
})

describe('summarize', () => {
  it('空值返回空串', () => {
    expect(summarize(null)).toBe('')
    expect(summarize(undefined)).toBe('')
  })

  it('优先展示错误，其次文本，再次 JSON', () => {
    expect(summarize({ error: '被沙箱拒绝' })).toBe('错误: 被沙箱拒绝')
    expect(summarize({ text: '命令输出' })).toBe('命令输出')
    expect(summarize({ json: { a: 1 } })).toBe('{"a":1}')
  })

  it('其它类型转字符串并截断', () => {
    expect(summarize('直接结果')).toBe('直接结果')
    expect(summarize('x'.repeat(300)).length).toBe(120)
  })
})

describe('rebuildMessages', () => {
  it('空事件返回空列表', () => {
    expect(rebuildMessages([], undefined, idGen())).toEqual([])
  })

  it('一轮完整回合合并为「一条用户 + 一条助手」', () => {
    const events = [
      { type: 'user', payload: { content: '修一下这个 bug' } },
      { type: 'assistant', payload: { content: '先读文件', toolCalls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }] } },
      { type: 'tool', payload: { name: 'read_file', result: { text: '文件内容' } } },
      { type: 'assistant', payload: { content: '已修复' } },
    ]
    const list = rebuildMessages(events, 's1', idGen())

    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ role: 'user', content: '修一下这个 bug' })
    const asst = list[1]
    expect(asst.role).toBe('assistant')
    expect(asst.content).toBe('已修复')
    expect(asst.sessionId).toBe('s1')
    // 调用工具前的零散描述归入思考，不污染结论
    expect(asst.thinking).toBe('先读文件')
    expect(asst.trace).toEqual([
      { type: 'step', step: 1 },
      { type: 'tool', toolName: 'read_file', toolArgs: '{"path":"a.ts"}', toolResult: '文件内容' },
      { type: 'step', step: 2 },
    ])
  })

  it('每步思考按预算截断后合并', () => {
    const events = [
      { type: 'user', payload: { content: '任务' } },
      { type: 'assistant', payload: { thinking: 'a'.repeat(4000), toolCalls: [{ name: 'shell', arguments: '{}' }] } },
      { type: 'assistant', payload: { thinking: '第二步思考' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    const asst = list[1]
    expect(asst.thinking).toContain('思考过长')
    expect(asst.thinking).toContain('第二步思考')
  })

  it('任务书挂到本轮助手消息上', () => {
    const events = [
      { type: 'user', payload: { content: '口语指令', refined: { instruction: '## 目标\n做 A' } } },
      { type: 'assistant', payload: { content: '好了' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list[1].brief).toBe('## 目标\n做 A')
  })

  it('没有任务书时不带 brief 字段', () => {
    const events = [
      { type: 'user', payload: { content: '你好' } },
      { type: 'assistant', payload: { content: '你好！' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list[1].brief).toBeUndefined()
  })

  it('多轮对话相互独立（第二轮不会并入第一轮的助手消息）', () => {
    const events = [
      { type: 'user', payload: { content: '第一问' } },
      { type: 'assistant', payload: { content: '第一答' } },
      { type: 'user', payload: { content: '第二问' } },
      { type: 'assistant', payload: { content: '第二答' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:第一问',
      'assistant:第一答',
      'user:第二问',
      'assistant:第二答',
    ])
  })

  it('纯文本助手消息不产生调用过程骨架', () => {
    const events = [
      { type: 'user', payload: { content: '你好' } },
      { type: 'assistant', payload: { content: '你好！' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list[1].trace).toEqual([])
  })

  it('工具结果回填到最近一条同名待回填记录', () => {
    const events = [
      { type: 'user', payload: { content: '跑两次同一个命令' } },
      { type: 'assistant', payload: { toolCalls: [{ name: 'shell', arguments: '{"command":"ls"}' }] } },
      { type: 'tool', payload: { name: 'shell', result: { text: '第一次输出' } } },
      { type: 'assistant', payload: { toolCalls: [{ name: 'shell', arguments: '{"command":"ls"}' }] } },
      { type: 'tool', payload: { name: 'shell', result: { text: '第二次输出' } } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    const tools = (list[1].trace ?? []).filter((t) => t.type === 'tool')
    expect(tools.map((t) => t.toolResult)).toEqual(['第一次输出', '第二次输出'])
  })

  it('缺少 assistant 记录的工具事件仍会出现在调用区', () => {
    const events = [
      { type: 'user', payload: { content: '任务' } },
      { type: 'tool', payload: { name: 'read_file', result: { text: '孤儿结果' } } },
      { type: 'assistant', payload: { content: '结论' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    const tools = (list[1].trace ?? []).filter((t) => t.type === 'tool')
    expect(tools).toEqual([{ type: 'tool', toolName: 'read_file', toolResult: '孤儿结果' }])
  })

  it('system/error 等过程事件不影响消息列表', () => {
    const events = [
      { type: 'user', payload: { content: '任务' } },
      { type: 'system', payload: { refineSkipped: '无需拆解' } },
      { type: 'error', payload: { reason: 'max-steps reached (70)' } },
      { type: 'assistant', payload: { content: '结论' } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list).toHaveLength(2)
    expect(list[1].content).toBe('结论')
  })

  it('图片附件被还原', () => {
    const events = [
      { type: 'user', payload: { content: '看图', attachments: [{ type: 'image', dataUrl: 'data:image/png;base64,AAA' }] } },
    ]
    const list = rebuildMessages(events, undefined, idGen())
    expect(list[0].images).toEqual(['data:image/png;base64,AAA'])
  })

  it('大量事件下不出现 O(n²) 级别的耗时（性能护栏）', () => {
    // 300 轮 × 4 事件：旧实现（每步 [x, y].join）在同样规模下会明显更慢
    const events: Array<{ type: string; payload: unknown }> = []
    for (let i = 0; i < 300; i++) {
      events.push({ type: 'user', payload: { content: `问题 ${i}` } })
      events.push({ type: 'assistant', payload: { thinking: 'x'.repeat(2000), toolCalls: [{ name: 'read_file', arguments: '{}' }] } })
      events.push({ type: 'tool', payload: { name: 'read_file', result: { text: 'y'.repeat(500) } } })
      events.push({ type: 'assistant', payload: { content: `结论 ${i}` } })
    }
    const t0 = performance.now()
    const list = rebuildMessages(events, undefined, idGen())
    const cost = performance.now() - t0
    expect(list).toHaveLength(600)
    expect(cost).toBeLessThan(1500)
  })
})
