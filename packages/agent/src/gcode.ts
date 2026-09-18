/**
 * G-code：结构化任务指令序列（编译产物 / DAG）。
 *
 * 设计哲学（对齐《Harness + G-code》架构思路）：
 * - 大模型只做一次「编译」：把模糊意图编译为 G-code，然后退出；
 * - tool 节点 = 确定性执行，零模型成本；
 * - model 节点 = 图纸上画死的定点模型调用（单次、指定模型与输出格式），
 *   模型调用不是消失，而是不再参与逐步决策；
 * - 失败以结构化错误码上报，由上层决定「规则修复」还是「升级给大模型兜底」。
 */

/** 错误处理策略：escalate=挂起并上报错误码（等医生）；ignore=失败视为空输出继续下游。 */
export type GOnError = 'escalate' | 'ignore'

/** 原子指令节点。所有节点共享：id、依赖（dependsOn）、重试（retry）、错误策略（onError）。 */
interface GNodeBase {
  /** 节点唯一 id，供依赖引用与 {{id}} 模板替换。 */
  id: string
  /** 依赖的前置节点 id 列表；无依赖的节点可并行执行。 */
  dependsOn?: string[]
  /** 失败重试次数（默认 0），重试属代码自愈，零模型成本。 */
  retry?: number
  /** 错误处理策略，默认 escalate。 */
  onError?: GOnError
}

/** 工具节点：调用注册表中的确定性工具（文件/API/DB 等），零模型成本。 */
export interface GToolNode extends GNodeBase {
  op: 'tool'
  /** 工具名（必须已注册）。 */
  tool: string
  /** 工具参数；字符串值内可用 {{nodeId}} 引用前置节点输出。 */
  args?: Record<string, unknown>
}

/** 定点模型节点：一次性单模型调用（无循环、无工具决策）。 */
export interface GModelNode extends GNodeBase {
  op: 'model'
  /** 提示词；可用 {{nodeId}} 引用前置节点输出。 */
  prompt: string
  /** 指定模型（如 flash-non-thinking / pro）；缺省用运行时默认模型。 */
  model?: string
  /** 输出格式：json 时校验可解析。 */
  output?: 'text' | 'json' | 'markdown'
  /** 温度（可选）。 */
  temperature?: number
}

/** 聚合节点：纯代码把多个前置输出按模板拼装为最终交付物，零模型成本。 */
export interface GAggregateNode extends GNodeBase {
  op: 'aggregate'
  /** 模板字符串，{{nodeId}} 替换为对应节点输出。 */
  template: string
}

export type GNode = GToolNode | GModelNode | GAggregateNode

/** 一份编译产物：DAG + 交付节点。 */
export interface GPlan {
  version: 1
  /** 本轮任务目标（一句话，供错误上报与兜底上下文）。 */
  goal: string
  nodes: GNode[]
  /** 交付节点 id：其输出即最终结论。 */
  deliver: string
}

/** 计划节点上限：超过则视为模型没有真正收敛出可执行计划（防止编译产物退化成"步骤清单幻觉"）。 */
export const MAX_PLAN_NODES = 24

/** 结构化错误码：执行层与意图层之间唯一的通信协议。 */
export interface PlanFailure {
  errorCode:
    | 'PLAN_UNPARSEABLE' // 编译输出不是合法 JSON / 缺字段
    | 'PLAN_INVALID' // schema 校验失败（未知工具、成环、悬空依赖等）
    | 'TOOL_FAILED' // 工具返回 error（含沙箱拒绝）
    | 'MODEL_FAILED' // 定点模型调用异常
    | 'MODEL_OUTPUT_INVALID' // output=json 但不可解析
    | 'TEMPLATE_UNRESOLVED' // {{ref}} 指向失败或被 ignore 清空的节点
  stepId: string
  context: string
}

/** 计划执行失败（含已完成节点的部分结果，供兜底/续跑）。 */
export class PlanExecutionError extends Error {
  constructor(
    readonly failure: PlanFailure,
    /** 已成功节点的输出（nodeId → 文本）。 */
    readonly partial: Record<string, string> = {},
  ) {
    super(`[${failure.errorCode}] ${failure.stepId}: ${failure.context}`)
    this.name = 'PlanExecutionError'
  }
}

function isNode(n: unknown): n is GNode {
  if (typeof n !== 'object' || n === null) return false
  const node = n as Record<string, unknown>
  if (typeof node.id !== 'string' || !node.id) return false
  if (node.op !== 'tool' && node.op !== 'model' && node.op !== 'aggregate') return false
  if (node.op === 'tool' && typeof node.tool !== 'string') return false
  if (node.op === 'model' && typeof node.prompt !== 'string') return false
  if (node.op === 'aggregate' && typeof node.template !== 'string') return false
  if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) return false
  if (node.onError !== undefined && node.onError !== 'escalate' && node.onError !== 'ignore') return false
  return true
}

/**
 * 校验编译产物：字段合法性 + 工具存在 + 依赖闭合 + 无环 + 交付可达。
 * 返回错误列表；空列表 = 合法。knownTools 为当前注册表工具名。
 */
export function validatePlan(plan: unknown, knownTools: Set<string>): string[] {
  const errors: string[] = []
  if (typeof plan !== 'object' || plan === null) return ['计划不是 JSON 对象']
  const p = plan as Record<string, unknown>
  if (p.version !== 1) errors.push('version 必须为 1')
  if (typeof p.goal !== 'string' || !p.goal.trim()) errors.push('缺少 goal')
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) errors.push('缺少 nodes')
  if (typeof p.deliver !== 'string' || !p.deliver) errors.push('缺少 deliver')
  if (errors.length) return errors

  const nodes = p.nodes as unknown[]
  if (nodes.length > MAX_PLAN_NODES) return [`节点数 ${nodes.length} 超过上限 ${MAX_PLAN_NODES}`]
  if (!nodes.every(isNode)) return ['存在不合法的节点（op/id/字段不符）']

  const typed = nodes as GNode[]
  const ids = new Set(typed.map((n) => n.id))
  if (ids.size !== typed.length) errors.push('节点 id 重复')
  if (!ids.has(p.deliver as string)) errors.push(`deliver "${p.deliver}" 不在节点列表中`)

  for (const n of typed) {
    if (n.op === 'tool' && !knownTools.has(n.tool)) errors.push(`节点 ${n.id} 引用未注册工具 "${n.tool}"`)
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`节点 ${n.id} 依赖不存在的节点 "${dep}"`)
      if (dep === n.id) errors.push(`节点 ${n.id} 依赖自身`)
    }
  }
  // 成环检测（Kahn 拓扑）
  if (!errors.length) {
    const indeg = new Map(typed.map((n) => [n.id, (n.dependsOn ?? []).length]))
    const children = new Map<string, string[]>(typed.map((n) => [n.id, []]))
    for (const n of typed) for (const dep of n.dependsOn ?? []) children.get(dep)!.push(n.id)
    const queue = typed.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
    let seen = 0
    while (queue.length) {
      const id = queue.shift()!
      seen += 1
      for (const c of children.get(id) ?? []) {
        indeg.set(c, indeg.get(c)! - 1)
        if (indeg.get(c) === 0) queue.push(c)
      }
    }
    if (seen < typed.length) errors.push('节点依赖存在环')
  }
  return errors
}

/** {{nodeId}} 模板替换；引用缺失/失败节点时返回 null（上层按错误码处理）。 */
export function resolveTemplate(text: string, results: Record<string, string>): string | null {
  let missing = false
  const out = text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, id: string) => {
    if (Object.prototype.hasOwnProperty.call(results, id)) return results[id]
    missing = true
    return ''
  })
  return missing ? null : out
}

/** 从模型自由输出中提取 JSON 计划（容忍 ```json 围栏与前后杂文）。 */
export function extractPlanJson(text: string): unknown | null {
  let s = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 依赖分层：同层节点无相互依赖，可并行执行。 */
export function topoLayers(nodes: GNode[]): GNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const layers: GNode[][] = []
  const done = new Set<string>()
  let rest = [...nodes]
  while (rest.length) {
    const layer = rest.filter((n) => (n.dependsOn ?? []).every((d) => done.has(d) || !byId.has(d)))
    if (layer.length === 0) break // 有环（validatePlan 已拦截，防御性兜底）
    layers.push(layer)
    for (const n of layer) done.add(n.id)
    rest = rest.filter((n) => !done.has(n.id))
  }
  return layers
}
