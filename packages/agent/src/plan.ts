/**
 * PlanAgent：G-code「编译 → 执行 → 兜底」最小闭环。
 *
 * 角色分工（三层不越界）：
 * 1. 大模型 = 编译器：一次调用，把需求编译为 G-code 计划，然后退出；
 * 2. 执行引擎 = 代码：拓扑分层执行（同层并行），零模型决策；
 * 3. 错误码 = 接口协议：节点失败产出结构化 {errorCode, stepId, context}，
 *    先由 retry（代码自愈）消化，仍失败才升级——把错误码连同部分结果交还给
 *    现有 AgentLoop 兜底（打电话叫医生）。
 */
import type { ChatMessage, ChatProvider, ChatResult } from '@zhuxing/harness-llm'
import type { ToolExecuteContext, ToolRegistry, ToolResult } from '@zhuxing/harness-tools'
import { toToolResultText } from '@zhuxing/harness-tools'
import type { AgentDeps, AgentOptions, AgentResult } from './index.js'
import { DEFAULT_SYSTEM_PROMPT } from './index.js'
import { AgentLoop } from './index.js'
import {
  PlanExecutionError,
  extractPlanJson,
  resolveTemplate,
  topoLayers,
  validatePlan,
  type GNode,
  type GPlan,
  type PlanFailure,
} from './gcode.js'
import {
  instantiateTemplate,
  isTemplateDisabled,
  normalizeTemplate,
  templateCatalog,
  type GTemplate,
  type TemplateStore,
} from './templates.js'

export interface PlanAgentOptions extends AgentOptions {
  /** 编译器使用的模型（缺省用 opts.model）；编译是一次性高价值调用，可用较强模型。 */
  planModel?: string
  /** 单模型节点超时（毫秒，默认 120s）。 */
  modelTimeoutMs?: number
  /** 模板库：传入后启用「复用优先 → 全量编译 → 成功沉淀」流程（缺省关闭，行为与纯编译一致）。 */
  templates?: TemplateStore
  /** 模板选择/泛化使用的模型（缺省用 planModel ?? model）。 */
  templateModel?: string
  /** 沉淀门槛：执行成功的节点数达到该值才值得泛化为模板（默认 3）。 */
  minTemplateNodes?: number
}

/** 编译产物附加信息（回传给调用方做成本统计/展示）。 */
export interface PlanRunInfo {
  compiled: boolean
  /** 计划节点执行数（不含 aggregate）。 */
  nodesExecuted: number
  /** 是否回退到 AgentLoop 兜底。 */
  fallback: boolean
  /** 回退原因（错误码）。 */
  failure?: PlanFailure
  /** 本次执行复用的模板 id（存在即代表走的是「目录选择 + 实例化」小输出路径）。 */
  templateId?: string
}

export interface PlanAgentResult extends AgentResult {
  plan?: PlanRunInfo
}

/** 编译器系统提示：只输出 G-code JSON，不参与执行。 */
function compilerPrompt(tools: ToolRegistry): string {
  const catalog = tools
    .list()
    .map((t) => `- ${t.name}: ${t.description} 参数schema: ${JSON.stringify(t.schema)}`)
    .join('\n')
  return (
    '你是任务编译器（只编译，不执行）。把用户需求编译为一份 G-code 结构化执行计划，' +
    '输出了一个 JSON 对象后立刻结束，除 JSON 外不得输出任何其他文字。\n' +
    'G-code 原则：\n' +
    '- 一次编译、多次执行：你的唯一职责是把需求一次性翻译成结构化指令，执行完全交给确定性引擎按依赖分层完成，你不在脑内逐步模拟执行；\n' +
    '- 确定性优先：凡能用工具（文件/API/DB）完成的一律用 tool 节点，语义生成/判断点才用 model 节点；\n' +
    '- 只声明「做什么、依赖谁」：每个节点必须可被某个已注册工具或一次性模型调用确定性地执行，不掺入寒暄与旁白；\n' +
    '- 失败才回退：无法用这些指令表达时按下方规则放弃编译，交由对话模型接管，不要勉强编译出错误的计划。\n' +
    'JSON 结构：\n' +
    '{"version":1,"goal":"一句话任务目标","nodes":[{"id":"n1","op":"tool","tool":"工具名","args":{},"dependsOn":[],"retry":0,"onError":"escalate|ignore"},' +
    '{"id":"n2","op":"model","prompt":"...","model":"可选模型名","output":"text|json|markdown"},' +
    '{"id":"n3","op":"aggregate","template":"{{n1}} ... {{n2}}"}],"deliver":"交付节点id"}\n' +
    '规则：\n' +
    '1. 优先用 tool 节点完成一切确定性工作（文件/API/DB），tool 必须是下方目录中的名字；\n' +
    '2. 只有语义生成/判断点才允许 model 节点，且必须是一次性调用（它不能调工具、不能循环）；\n' +
    '3. 最终交付物节点（model 或 aggregate）填进 deliver 字段；\n' +
    '4. 无依赖的节点会被并行执行，能用并行就不要串；字符串里用 {{节点id}} 引用前置输出；\n' +
    '5. 步骤总数不超过 24；如果任务无法用这些指令表达（强探索/多轮交互），只输出 ' +
    '{"version":1,"goal":"...","nodes":[],"deliver":""} 表示放弃编译。\n' +
    '可用工具目录：\n' +
    catalog
  )
}

/**
 * 编译/选择器用的紧凑历史（借鉴 dsh「按需最小上下文」）：
 * 只保留最近 keep 条 user/assistant 文本要点（各截 maxChars 字符），
 * 工具调用/结果噪音全部剔除——编译一次计划并不需要重放整个执行过程。
 */
export function compactHistory(history: ChatMessage[] | undefined, keep = 6, maxChars = 400): ChatMessage[] {
  if (!history || history.length === 0) return []
  const texts = history.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0,
  )
  return texts.slice(-keep).map((m) => {
    const c = (m.content as string).trim()
    return {
      role: m.role,
      content: c.length > maxChars ? `${c.slice(0, maxChars)}…` : c,
    } as ChatMessage
  })
}

/** 编译：一次模型调用 → G-code 计划（校验不过即 PLAN_* 错误，由上层回退）。 */
export async function compilePlan(
  llm: ChatProvider,
  tools: ToolRegistry,
  userInput: string,
  history: ChatMessage[] | undefined,
  opts: { model?: string },
): Promise<GPlan> {
  const messages: ChatMessage[] = [{ role: 'system', content: compilerPrompt(tools) }]
  messages.push(...compactHistory(history))
  messages.push({ role: 'user', content: userInput })
  let res: ChatResult
  try {
    // 编译器是机械转换调用：DeepSeek 关思维链省输出计费，JSON 模式保证可解析，输出设上限。
    res = await llm.chat(messages, { model: opts.model, temperature: 0, thinking: 'disabled', jsonMode: true, maxTokens: 4096 })
  } catch (err) {
    throw new PlanExecutionError({
      errorCode: 'PLAN_UNPARSEABLE',
      stepId: 'compile',
      context: err instanceof Error ? err.message : String(err),
    })
  }
  const parsed = extractPlanJson(res.content ?? '')
  if (parsed === null) {
    throw new PlanExecutionError({
      errorCode: 'PLAN_UNPARSEABLE',
      stepId: 'compile',
      context: `编译输出无法解析为 JSON：${String(res.content ?? '').slice(0, 200)}`,
    })
  }
  const plan = parsed as GPlan
  // 空 nodes = 模型判定任务不适合编译
  if (Array.isArray(plan.nodes) && plan.nodes.length === 0 && !plan.deliver) {
    throw new PlanExecutionError({
      errorCode: 'PLAN_INVALID',
      stepId: 'compile',
      context: '模型判定任务不适合编译（nodes 为空）',
    })
  }
  const known = new Set(tools.list().map((t) => t.name))
  const errors = validatePlan(plan, known)
  if (errors.length > 0) {
    throw new PlanExecutionError({
      errorCode: 'PLAN_INVALID',
      stepId: 'compile',
      context: errors.join('；'),
    })
  }
  return plan
}

/** 执行单个节点；失败抛 PlanExecutionError（onError=ignore 时返回空串）。 */
async function execNode(
  node: GNode,
  plan: GPlan,
  results: Record<string, string>,
  deps: AgentDeps,
  opts: PlanAgentOptions,
  executeCtx: ToolExecuteContext,
): Promise<string> {
  const attempts = (node.retry ?? 0) + 1
  let lastFailure: PlanFailure | undefined

  for (let i = 0; i < attempts; i++) {
    try {
      if (node.op === 'tool') {
        // 参数模板替换（字符串值内的 {{id}}）
        const args: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node.args ?? {})) {
          if (typeof v === 'string') {
            const r = resolveTemplate(v, results)
            if (r === null) throw new PlanExecutionError({ errorCode: 'TEMPLATE_UNRESOLVED', stepId: node.id, context: `参数 ${k} 引用了失败节点` })
            args[k] = r
          } else args[k] = v
        }
        const tr: ToolResult = await deps.tools.execute(node.tool, args, executeCtx)
        if (tr.error !== undefined) {
          lastFailure = { errorCode: 'TOOL_FAILED', stepId: node.id, context: `${node.tool}: ${tr.error}` }
          // 记录到会话（与 AgentLoop 事件形状一致：assistant 发起 + tool 响应，保证历史重建合法）
          await deps.session.append('assistant', 'plan', {
            content: '',
            toolCalls: [{ id: node.id, name: node.tool, arguments: JSON.stringify(args) }],
          })
          await deps.session.append('tool', 'plan', { callId: node.id, name: node.tool, args, result: tr })
          continue // 重试
        }
        const text = toToolResultText(tr)
        await deps.session.append('assistant', 'plan', {
          content: '',
          toolCalls: [{ id: node.id, name: node.tool, arguments: JSON.stringify(args) }],
        })
        await deps.session.append('tool', 'plan', { callId: node.id, name: node.tool, args, result: tr })
        return text
      }

      if (node.op === 'model') {
        const prompt = resolveTemplate(node.prompt, results)
        if (prompt === null) throw new PlanExecutionError({ errorCode: 'TEMPLATE_UNRESOLVED', stepId: node.id, context: '提示词引用了失败节点' })
        let res: ChatResult
        try {
          if (node.id === plan.deliver && opts.onToken && typeof deps.llm.stream === 'function') {
            // 交付节点流式输出（其余定点模型调用一次性取结果）
            res = await streamOnce(deps.llm, [{ role: 'user', content: prompt }], {
              model: node.model ?? opts.planModel ?? opts.model,
              temperature: node.temperature ?? opts.temperature,
            }, opts.onToken)
          } else {
            res = await deps.llm.chat([{ role: 'user', content: prompt }], {
              model: node.model ?? opts.planModel ?? opts.model,
              temperature: node.temperature ?? opts.temperature,
            })
          }
        } catch (err) {
          lastFailure = { errorCode: 'MODEL_FAILED', stepId: node.id, context: err instanceof Error ? err.message : String(err) }
          continue
        }
        const content = res.content ?? ''
        if (node.output === 'json') {
          try {
            JSON.parse(content)
          } catch {
            lastFailure = { errorCode: 'MODEL_OUTPUT_INVALID', stepId: node.id, context: '输出不是合法 JSON' }
            continue
          }
        }
        await deps.session.append('assistant', 'plan', { content })
        return content
      }

      // aggregate：纯代码拼装，零模型成本
      const text = resolveTemplate(node.template, results)
      if (text === null) throw new PlanExecutionError({ errorCode: 'TEMPLATE_UNRESOLVED', stepId: node.id, context: '模板引用了失败节点' })
      return text
    } catch (err) {
      if (err instanceof PlanExecutionError) throw err
      lastFailure = { errorCode: 'TOOL_FAILED', stepId: node.id, context: err instanceof Error ? err.message : String(err) }
    }
  }

  const failure = lastFailure ?? { errorCode: 'TOOL_FAILED', stepId: node.id, context: '未知失败' }
  if (node.onError === 'ignore') return ''
  throw new PlanExecutionError(failure, { ...results })
}

async function streamOnce(
  llm: ChatProvider,
  messages: ChatMessage[],
  options: import('@zhuxing/harness-llm').ChatOptions,
  onToken?: (t: string) => void,
  onReasoning?: (t: string) => void,
): Promise<ChatResult> {
  let result: ChatResult | undefined
  for await (const chunk of llm.stream!(messages, options)) {
    if (chunk.token) onToken?.(chunk.token)
    if (chunk.reasoning) onReasoning?.(chunk.reasoning)
    if (chunk.done) result = chunk.done
  }
  return result ?? { content: '', toolCalls: [], finishReason: 'stop' }
}

/** 确定性执行计划：拓扑分层，同层并行。 */
export async function runPlan(
  plan: GPlan,
  deps: AgentDeps,
  opts: PlanAgentOptions,
  userInput: string,
): Promise<{ content: string; nodesExecuted: number }> {
  const executeCtx: ToolExecuteContext = {
    sandbox: deps.sandbox,
    logger: deps.logger,
    emit: deps.emit,
    sessionId: deps.session.id,
  }
  const results: Record<string, string> = {}
  let nodesExecuted = 0

  // 模型可见即记录：用户输入先入日志（编译本身不占模型可见历史）
  await deps.session.append('user', 'plan', { content: userInput })
  await deps.session.append('system', 'plan', { compiled: true, goal: plan.goal, nodes: plan.nodes.length, deliver: plan.deliver })
  await deps.emit?.('plan/compiled', { sessionId: deps.session.id, goal: plan.goal, nodes: plan.nodes.length })

  for (const layer of topoLayers(plan.nodes)) {
    const outs = await Promise.all(
      layer.map(async (node) => {
        const out = await execNode(node, plan, { ...results }, deps, opts, executeCtx)
        return [node.id, out] as const
      }),
    )
    for (const [id, out] of outs) results[id] = out
    nodesExecuted += layer.length
    await deps.emit?.('plan/layer', { sessionId: deps.session.id, executed: nodesExecuted })
  }

  const content = results[plan.deliver] ?? ''
  // 交付节点为 model 时其输出已作为 assistant 事件记录；其余类型补记一条，保证历史重建有最终答复
  if (!plan.nodes.some((n) => n.id === plan.deliver && n.op === 'model')) {
    await deps.session.append('assistant', 'plan', { content })
  }
  await deps.session.append('system', 'plan', { delivered: true, nodesExecuted })
  return { content, nodesExecuted }
}

/** 选择器系统提示：只看目录，输出极小 JSON（id + 参数），不参与执行。 */
function selectorPrompt(catalog: string): string {
  return (
    '你是 G-code 模板复用调度器。下面是已沉淀的流程模板目录，你的唯一任务是判断用户需求能否复用其中一份模板，' +
    '输出一个 JSON 对象后立刻结束，除 JSON 外不得输出任何其他文字。\n' +
    'JSON 结构：\n' +
    '{"template":"模板id或null","params":{"参数名":"参数值"}}\n' +
    '规则：\n' +
    '1. 只有当用户请求与模板「适用」描述明确吻合、且能从请求中提取出全部必填参数时才可命中；否则 template 填 null；\n' +
    '2. 参数值必须来自用户请求原文，不得臆造；\n' +
    '3. 宁可放弃复用（null），不可强行套用——命中后引擎会照原样执行该模板。\n' +
    '模板目录：\n' +
    catalog
  )
}

/** 泛化器系统提示：把成功的计划抽象为参数化模板。 */
function generalizerPrompt(): string {
  return (
    '你是流程固化师（只固化，不执行）。给定一份刚刚成功执行过的 G-code 计划，请把它沉淀为可复用的参数化模板，' +
    '输出一个 JSON 对象后立刻结束，除 JSON 外不得输出任何其他文字。\n' +
    'JSON 结构：\n' +
    '{"id":"模板短id（小写短横线）","summary":"一句话说明","whenToUse":"什么样的用户请求适用（供下次挑选）",' +
    '"params":[{"name":"参数名","desc":"含义","required":true}],"plan":{参数化后的计划}}\n' +
    '规则：\n' +
    '1. 把「下一次同类请求会变化的值」（对象、路径、名称、数量等）替换为 {{params.参数名}}，其余结构原样保留；\n' +
    '2. 节点 id、依赖关系、工具名、固定话术不得改动；plan 必须仍是合法的 G-code；\n' +
    '3. 只在确实存在可变量时引入参数；如果计划完全不可复用，输出 {"id":null}；\n' +
    '4. params 中声明的参数必须在 plan 中至少被引用一次。'
  )
}

/**
 * 尝试模板复用：目录 → 模型选书（极小输出）→ 代码实例化 → 静态校验。
 * 任何一步不合适都返回 null（静默回全量编译，不算失败）。
 */
async function selectTemplate(
  deps: AgentDeps,
  opts: PlanAgentOptions,
  userInput: string,
  history: ChatMessage[] | undefined,
): Promise<{ templateId: string; plan: GPlan } | null> {
  if (!opts.templates) return null
  try {
    const active = (await opts.templates.list()).filter((t) => !isTemplateDisabled(t))
    if (active.length === 0) return null
    const messages: ChatMessage[] = [{ role: 'system', content: selectorPrompt(templateCatalog(active)) }]
    messages.push(...compactHistory(history))
    messages.push({ role: 'user', content: userInput })
    const res = await deps.llm.chat(messages, {
      model: opts.templateModel ?? opts.planModel ?? opts.model,
      temperature: 0,
      thinking: 'disabled',
      jsonMode: true,
      maxTokens: 256,
    })
    const parsed = extractPlanJson(res.content ?? '')
    if (parsed === null) return null
    const j = parsed as Record<string, unknown>
    if (typeof j.template !== 'string' || !j.template) return null
    const tpl = active.find((t) => t.id === j.template)
    if (!tpl) return null
    const params = (typeof j.params === 'object' && j.params !== null ? j.params : {}) as Record<string, unknown>
    const plan = instantiateTemplate(tpl, params)
    if (plan === null) return null
    const known = new Set(deps.tools.list().map((t) => t.name))
    if (validatePlan(plan, known).length > 0) return null
    return { templateId: tpl.id, plan }
  } catch {
    return null
  }
}

/** 沉淀：把成功执行的计划泛化为模板；模型拒绝或产物非法返回 null（静默跳过）。 */
async function generalizeTemplate(
  deps: AgentDeps,
  opts: PlanAgentOptions,
  userInput: string,
  plan: GPlan,
): Promise<GTemplate | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: generalizerPrompt() },
      { role: 'user', content: `原始需求：${userInput}\n\n成功执行的计划：\n${JSON.stringify(plan)}` },
    ]
    const res = await deps.llm.chat(messages, {
      model: opts.templateModel ?? opts.planModel ?? opts.model,
      temperature: 0,
      thinking: 'disabled',
      jsonMode: true,
      maxTokens: 2048,
    })
    const parsed = extractPlanJson(res.content ?? '')
    if (parsed === null) return null
    const tpl = normalizeTemplate(parsed)
    if (tpl === null) return null
    const known = new Set(deps.tools.list().map((t) => t.name))
    if (validatePlan(tpl.plan, known).length > 0) return null
    return tpl
  } catch {
    return null
  }
}

/**
 * PlanAgent：与 AgentLoop 同构（deps/options/run 签名一致），可直接替换。
 * 流程：模板复用（可选）→ compile 一次 → 确定性执行 → 成功沉淀模板；
 * 任何 PLAN_* / escalate 失败 → 携错误码回退 AgentLoop。
 */
export class PlanAgent {
  constructor(
    private deps: AgentDeps,
    private opts: PlanAgentOptions = {},
  ) {}

  /** 记录模板执行结果（治理计数）：存储异常不影响主流程。 */
  private async recordTemplateResult(templateId: string, ok: boolean): Promise<void> {
    try {
      await this.opts.templates?.recordResult(templateId, ok)
    } catch {
      /* 治理计数失败静默 */
    }
  }

  async run(userInput: string, history?: ChatMessage[]): Promise<PlanAgentResult> {
    const { session } = this.deps
    let reuse: { templateId: string; plan: GPlan } | null = null
    try {
      // 复用优先：目录命中则只花一次「极小输出」调用，不再全量编译
      reuse = await selectTemplate(this.deps, this.opts, userInput, history)
      if (reuse) {
        await session.append('system', 'plan', { templateReuse: reuse.templateId, goal: reuse.plan.goal, nodes: reuse.plan.nodes.length })
        await this.deps.emit?.('plan/template-hit', { sessionId: session.id, templateId: reuse.templateId })
      }
      const plan = reuse ? reuse.plan : await compilePlan(this.deps.llm, this.deps.tools, userInput, history, { model: this.opts.planModel ?? this.opts.model })
      const { content, nodesExecuted } = await runPlan(plan, this.deps, this.opts, userInput)
      if (reuse) {
        await this.recordTemplateResult(reuse.templateId, true)
      } else if (this.opts.templates && nodesExecuted >= (this.opts.minTemplateNodes ?? 3)) {
        // 成功沉淀：把本次具体计划泛化为参数化模板，供下次小输出复用
        const tpl = await generalizeTemplate(this.deps, this.opts, userInput, plan)
        if (tpl) {
          try {
            await this.opts.templates.save(tpl)
            await this.deps.emit?.('plan/templated', { sessionId: session.id, templateId: tpl.id, params: tpl.params.map((p) => p.name) })
          } catch {
            /* 沉淀失败静默 */
          }
        }
      }
      return {
        content,
        steps: nodesExecuted,
        sessionId: session.id,
        finishedReason: 'stop',
        plan: { compiled: !reuse, nodesExecuted, fallback: false, templateId: reuse?.templateId },
      }
    } catch (err) {
      if (!(err instanceof PlanExecutionError)) throw err
      if (reuse) await this.recordTemplateResult(reuse.templateId, false)
      // 错误码是两界协议：把结构化失败翻译成兜底上下文（含已完成部分，避免重复施工）
      const note =
        `\n\n【计划执行回退】先前按结构化计划执行失败（errorCode=${err.failure.errorCode}, step=${err.failure.stepId}）：${err.failure.context}\n` +
        (Object.keys(err.partial).length
          ? `计划已完成部分节点：${Object.keys(err.partial).join(', ')}（其输出已在会话中），请基于现状继续完成任务，勿重复已成功步骤。`
          : '请按常规方式完成任务。')
      await session.append('system', 'plan', {
        fallback: true,
        failure: err.failure,
        partialNodes: Object.keys(err.partial),
      })
      await this.deps.emit?.('plan/escalate', { sessionId: session.id, failure: err.failure })
      const loop = new AgentLoop(this.deps, {
        ...this.opts,
        systemPrompt: this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      })
      const result = await loop.run(`${userInput}${note}`, history)
      return {
        ...result,
        plan: { compiled: !err.failure.stepId.startsWith('compile'), nodesExecuted: 0, fallback: true, failure: err.failure, templateId: reuse?.templateId },
      }
    }
  }
}
