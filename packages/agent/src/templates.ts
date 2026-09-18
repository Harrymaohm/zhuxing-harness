/**
 * G-code 模板库：成功流程的「固化 → 复用」层。
 *
 * 定位（对齐《Harness + G-code》第八节 CLI 演进路径）：
 * - 沉淀：一次完整编译 + 执行成功后，由模型把具体计划泛化为参数化模板
 *   （可变值替换为 {{params.name}}），注册进模板库；
 * - 复用：下次同类请求，模型只需「翻目录选书」——输出模板 id + 参数
 *   （极小输出），引擎实例化后一次性确定性执行，不再全量编译；
 * - 治理：执行失败计数，反复失败的模板自动禁用（模板也会被证伪）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GPlan } from './gcode.js'

/** 模板参数槽声明。 */
export interface GTemplateParam {
  name: string
  desc: string
  /** 缺省视为必填：选择器未给出该参数时模板不可用。 */
  required?: boolean
}

/** 一份参数化 G-code 模板。 */
export interface GTemplate {
  /** 短横线小写 id（目录内唯一）。 */
  id: string
  /** 一句话说明（目录卡片）。 */
  summary: string
  /** 适用特征描述：供选择器判断「什么请求该用它」。 */
  whenToUse: string
  params: GTemplateParam[]
  /** 参数化计划：字符串值中的可变部分写 {{params.name}}。 */
  plan: GPlan
  successCount: number
  failCount: number
  createdAt: number
  updatedAt: number
}

/** 模板库存储接口（内存 / 文件两种实现）。 */
export interface TemplateStore {
  list(): Promise<GTemplate[]>
  /** upsert：同 id 已存在时合并计数、覆盖内容。 */
  save(t: GTemplate): Promise<void>
  /** 记录一次执行结果（成功/失败），供自动禁用治理。 */
  recordResult(id: string, ok: boolean): Promise<void>
}

/** 失败禁用阈值：失败次数达到该值且多于成功次数 → 模板下线。 */
export const TEMPLATE_FAIL_LIMIT = 3

export function isTemplateDisabled(t: GTemplate): boolean {
  return t.failCount >= TEMPLATE_FAIL_LIMIT && t.failCount > t.successCount
}

/** 渲染「目录卡片」文本：只含摘要，不含计划全文（选择器只看目录）。 */
export function templateCatalog(templates: GTemplate[]): string {
  return templates
    .map((t) => {
      const params = t.params.length
        ? t.params.map((p) => `${p.name}${p.required === false ? '' : '（必填）'}—${p.desc}`).join('；')
        : '无'
      return `- ${t.id}: ${t.summary}\n  适用：${t.whenToUse}\n  参数：${params}`
    })
    .join('\n')
}

/** {{params.name}} 引用（注意与节点输出引用 {{nodeId}} 不冲突：id 不允许含点）。 */
const PARAM_REF = /\{\{\s*params\.([A-Za-z_]\w*)\s*\}\}/g

/**
 * 实例化：把参数值填入模板计划。
 * 任一必填参数缺失、或计划中仍存在未解析的 {{params.}} 引用 → 返回 null（视为不可复用）。
 */
export function instantiateTemplate(t: GTemplate, params: Record<string, unknown>): GPlan | null {
  const provided = new Map<string, string>()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' && v.trim()) provided.set(k, v)
    else if (typeof v === 'number' || typeof v === 'boolean') provided.set(k, String(v))
  }
  for (const p of t.params) {
    if (p.required !== false && !provided.has(p.name)) return null
  }
  const declared = new Set(t.params.map((p) => p.name))
  const subst = (s: string): string | null => {
    let ok = true
    const out = s.replace(PARAM_REF, (_m, name: string) => {
      if (!declared.has(name) || !provided.has(name)) {
        ok = false
        return ''
      }
      return provided.get(name)!
    })
    return ok ? out : null
  }

  const plan = JSON.parse(JSON.stringify(t.plan)) as GPlan
  for (const node of plan.nodes as unknown as Record<string, unknown>[]) {
    for (const key of ['prompt', 'template', 'tool'] as const) {
      if (typeof node[key] === 'string') {
        const r = subst(node[key] as string)
        if (r === null) return null
        node[key] = r
      }
    }
    if (node.args && typeof node.args === 'object') {
      for (const [k, v] of Object.entries(node.args as Record<string, unknown>)) {
        if (typeof v === 'string') {
          const r = subst(v)
          if (r === null) return null
          ;(node.args as Record<string, unknown>)[k] = r
        }
      }
    }
  }
  if (typeof plan.goal === 'string') {
    const r = subst(plan.goal)
    if (r !== null) plan.goal = r
  }
  // 防御：非字符串位置（数组元素等）残留的 params 引用 → 拒绝复用
  if (JSON.stringify(plan).includes('{{params.')) return null
  return plan
}

/** 收集计划中实际引用到的参数名。 */
export function collectParamRefs(plan: GPlan): Set<string> {
  const refs = new Set<string>()
  JSON.stringify(plan).replace(new RegExp(PARAM_REF.source, 'g'), (_m, name: string) => {
    refs.add(name)
    return ''
  })
  return refs
}

function sanitizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `tpl-${Date.now()}`
}

/** 归一化模型产出的候选模板：结构校验 + 参数声明与引用对齐。非法返回 null。 */
export function normalizeTemplate(raw: unknown): GTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const j = raw as Record<string, unknown>
  if (typeof j.id !== 'string' || !j.id.trim()) return null
  if (typeof j.summary !== 'string' || !j.summary.trim()) return null
  const plan = j.plan as GPlan
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.nodes) || plan.nodes.length === 0) return null
  const refs = collectParamRefs(plan)
  const declared = new Map<string, GTemplateParam>()
  if (Array.isArray(j.params)) {
    for (const p of j.params as unknown[]) {
      if (typeof p === 'object' && p !== null) {
        const pp = p as Record<string, unknown>
        if (typeof pp.name === 'string' && pp.name) {
          declared.set(pp.name, { name: pp.name, desc: typeof pp.desc === 'string' ? pp.desc : '', required: pp.required !== false })
        }
      }
    }
  }
  // 引用的参数必须有声明；声明了但未引用的参数剔除（防参数幻觉）
  for (const r of refs) {
    if (!declared.has(r)) return null
  }
  const now = Date.now()
  return {
    id: sanitizeId(j.id),
    summary: j.summary.trim(),
    whenToUse: typeof j.whenToUse === 'string' ? j.whenToUse.trim() : j.summary.trim(),
    params: [...declared.values()].filter((p) => refs.has(p.name)),
    plan,
    successCount: 1,
    failCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** 进程内模板库（测试 / 无持久化场景）。 */
export class MemoryTemplateStore implements TemplateStore {
  private items = new Map<string, GTemplate>()
  constructor(initial: GTemplate[] = []) {
    for (const t of initial) this.items.set(t.id, t)
  }
  async list(): Promise<GTemplate[]> {
    return [...this.items.values()]
  }
  async save(t: GTemplate): Promise<void> {
    const prev = this.items.get(t.id)
    this.items.set(t.id, {
      ...t,
      successCount: t.successCount + (prev?.successCount ?? 0),
      failCount: t.failCount + (prev?.failCount ?? 0),
      createdAt: prev?.createdAt ?? t.createdAt,
    })
  }
  async recordResult(id: string, ok: boolean): Promise<void> {
    const t = this.items.get(id)
    if (!t) return
    if (ok) t.successCount += 1
    else t.failCount += 1
    t.updatedAt = Date.now()
  }
}

/** 文件模板库：单个 JSON 文件持久化（与 memory 的 FileMemoryStore 同风格，写入原子替换）。 */
export class FileTemplateStore implements TemplateStore {
  private cache?: GTemplate[]
  private loading?: Promise<GTemplate[]>

  constructor(private path: string) {}

  private load(): Promise<GTemplate[]> {
    if (this.cache) return Promise.resolve(this.cache)
    if (this.loading) return this.loading
    this.loading = (async () => {
      let items: GTemplate[] = []
      try {
        if (existsSync(this.path)) {
          const parsed = JSON.parse(readFileSync(this.path, 'utf-8'))
          if (Array.isArray(parsed)) items = parsed as GTemplate[]
        }
      } catch {
        /* 文件损坏时按空库处理，不阻断对话 */
      }
      this.cache = items
      this.loading = undefined
      return items
    })()
    return this.loading
  }

  private persist(items: GTemplate[]): Promise<void> {
    this.cache = items
    return (async () => {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(items, null, 2))
      renameSync(tmp, this.path)
    })()
  }

  async list(): Promise<GTemplate[]> {
    return [...(await this.load())]
  }
  async save(t: GTemplate): Promise<void> {
    const items = await this.load()
    const idx = items.findIndex((x) => x.id === t.id)
    if (idx >= 0) {
      const prev = items[idx]
      items[idx] = {
        ...t,
        successCount: t.successCount + prev.successCount,
        failCount: t.failCount + prev.failCount,
        createdAt: prev.createdAt,
      }
    } else {
      items.push(t)
    }
    await this.persist(items)
  }
  async recordResult(id: string, ok: boolean): Promise<void> {
    const items = await this.load()
    const t = items.find((x) => x.id === id)
    if (!t) return
    if (ok) t.successCount += 1
    else t.failCount += 1
    t.updatedAt = Date.now()
    await this.persist(items)
  }
}
