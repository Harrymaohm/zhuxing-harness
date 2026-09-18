/**
 * 任务层评测：任务定义 Schema 与加载器。
 *
 * 设计要点
 * - 任务以 JSON 文件形式版本化（Golden Dataset），与 Harness 版本一一对应；
 * - 校验在加载期一次性完成：字段缺失 / 枚举越界 / 路径不存在 都在跑之前报错，
 *   避免「跑完 30 分钟才发现任务定义写错」；
 * - 兼容计划案给出的 snake_case 字段名（task_type / max_steps / max_token_budget /
 *   allowed_paths / forbidden_commands），内部统一归一为 camelCase。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 任务类型（对齐计划案 2.1 的覆盖比例口径）。 */
export const TASK_TYPES = [
  'bug_fix',
  'feature',
  'refactor',
  'test_authoring',
  'failure_recovery',
  'security_boundary',
]

/** 可评分的维度（对齐计划案 4.1 / 8.1）。 */
export const SCORING_DIMENSIONS = ['outcome', 'process', 'compliance', 'cost']

/** 评测隔离方式：worktree=真实仓库工作树；fixture=自包含素材目录（零外部依赖）。 */
export const REPO_MODES = ['worktree', 'fixture']

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3']

/**
 * 语料目录内允许存在的非任务 JSON（`run-tasks.mjs` 默认从这里取费率表）。
 * 加载器必须显式跳过，否则会被当作任务定义送进 `normalizeTask` 并因缺 id/taskType 报错，
 * 导致「费率表和任务语料不能同目录」这种荒谬约束。
 */
export const RESERVED_TASK_FILES = new Set(['pricing.json'])

/** 默认约束：与 CLI 默认 maxSteps=70 相比收紧，防止任务被无限步数拖垮。 */
export const DEFAULT_CONSTRAINTS = {
  maxSteps: 30,
  maxWallMs: 600_000,
  allowedPaths: [],
  forbiddenCommands: [],
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0
}

/** 取字段值：优先 camelCase，回退 snake_case 别名。 */
function pick(obj, camel, snake) {
  if (!isPlainObject(obj)) return undefined
  if (obj[camel] !== undefined) return obj[camel]
  if (snake && obj[snake] !== undefined) return obj[snake]
  return undefined
}

function normalizeStringArray(v) {
  if (v === undefined) return []
  if (!Array.isArray(v)) return undefined
  if (!v.every((x) => typeof x === 'string' && x.trim().length > 0)) return undefined
  return v.map((x) => x.trim())
}

/**
 * fixture 素材路径**相对任务文件**解析，而非相对仓库根。
 *
 * 素材是任务语料的一部分，必须跟着任务文件走：否则同一份任务在不同的 cwd 下
 * 会指向不同的目录，评测就失去了可复现性。归一化期一次性解析成绝对路径，
 * 下游（prepareWorkspace）不再做二次猜测。
 */
function resolveFixture(p, ctx) {
  if (typeof p !== 'string' || p.trim().length === 0) return undefined
  if (isAbsolute(p)) return resolve(p)
  const base = ctx.file ? dirname(resolve(ctx.file)) : resolve(ctx.dir)
  return resolve(base, p)
}

/**
 * 归一化 + 校验单个任务定义。
 * @param {unknown} raw 任务 JSON 原文
 * @param {{ dir: string, repoRoot: string, file?: string }} ctx 任务所在目录与仓库根
 * @returns {{ task: object|null, errors: string[] }}
 */
export function normalizeTask(raw, ctx) {
  const errors = []
  const where = ctx.file ? `${ctx.file}` : '(inline)'
  const fail = (msg) => errors.push(`${where}: ${msg}`)

  if (!isPlainObject(raw)) {
    fail('任务定义必须是 JSON 对象')
    return { task: null, errors }
  }

  const id = raw.id
  if (!isNonEmptyString(id) || !ID_RE.test(id)) {
    fail('id 必须匹配 ^[a-z0-9][a-z0-9._-]{2,63}$')
  }

  const taskType = pick(raw, 'taskType', 'task_type')
  if (!TASK_TYPES.includes(taskType)) {
    fail(`taskType 必须是 ${TASK_TYPES.join(' | ')} 之一`)
  }

  if (!isNonEmptyString(raw.task)) fail('task 提示词缺失')

  // ---- repository ----
  const repo = isPlainObject(raw.repository) ? raw.repository : {}
  const mode = repo.mode ?? 'worktree'
  if (!REPO_MODES.includes(mode)) fail(`repository.mode 必须是 ${REPO_MODES.join(' | ')}`)
  if (mode === 'worktree') {
    if (!isNonEmptyString(repo.url ?? repo.path ?? '.')) fail('worktree 模式需要 repository.path')
  } else if (!isNonEmptyString(repo.fixture)) {
    fail('fixture 模式需要 repository.fixture（素材目录）')
  }
  const ref = repo.ref ?? 'HEAD'
  if (!isNonEmptyString(ref)) fail('repository.ref 必须是非空字符串')

  // ---- verification ----
  const v = isPlainObject(raw.verification) ? raw.verification : null
  if (!v) fail('verification 缺失')
  const f2p = normalizeStringArray(v?.failToPass ?? v?.fail_to_pass)
  const p2p = normalizeStringArray(v?.passToPass ?? v?.pass_to_pass)
  if (f2p === undefined) fail('verification.failToPass 必须是字符串数组')
  if (p2p === undefined) fail('verification.passToPass 必须是字符串数组')
  if (f2p && f2p.length === 0) fail('verification.failToPass 不能为空（否则无法判定任务是否真的完成）')
  const command = v?.command
  if (!isNonEmptyString(command)) fail('verification.command 缺失')
  const runner = v?.runner ?? 'tap'
  if (!['tap', 'tsc'].includes(runner)) fail("verification.runner 必须是 'tap' | 'tsc'")

  // ---- constraints ----
  const c = isPlainObject(raw.constraints) ? raw.constraints : {}
  const allowedPaths = normalizeStringArray(pick(c, 'allowedPaths', 'allowed_paths'))
  const forbiddenCommands = normalizeStringArray(pick(c, 'forbiddenCommands', 'forbidden_commands') ?? [])
  if (allowedPaths === undefined) fail('constraints.allowedPaths 必须是字符串数组')
  if (forbiddenCommands === undefined) fail('constraints.forbiddenCommands 必须是字符串数组')

  const maxSteps = Number(pick(c, 'maxSteps', 'max_steps') ?? DEFAULT_CONSTRAINTS.maxSteps)
  const maxWallMs = Number(pick(c, 'maxWallMs', 'max_wall_ms') ?? DEFAULT_CONSTRAINTS.maxWallMs)
  const maxTokenBudgetRaw = pick(c, 'maxTokenBudget', 'max_token_budget')
  const maxTokenBudget = maxTokenBudgetRaw === undefined ? undefined : Number(maxTokenBudgetRaw)
  if (!Number.isInteger(maxSteps) || maxSteps < 1) fail('constraints.maxSteps 必须是正整数')
  if (!Number.isFinite(maxWallMs) || maxWallMs < 1000) fail('constraints.maxWallMs 必须 >= 1000')
  if (maxTokenBudget !== undefined && (!Number.isFinite(maxTokenBudget) || maxTokenBudget < 1)) {
    fail('constraints.maxTokenBudget 必须是正整数')
  }

  // ---- scoring / 元信息 ----
  const scoring = normalizeStringArray(raw.scoring ?? SCORING_DIMENSIONS)
  if (scoring === undefined || scoring.some((d) => !SCORING_DIMENSIONS.includes(d))) {
    fail(`scoring 只能是 ${SCORING_DIMENSIONS.join(' | ')} 的子集`)
  }
  const severity = raw.severity ?? 'P1'
  if (!SEVERITIES.includes(severity)) fail(`severity 必须是 ${SEVERITIES.join(' | ')}`)

  const baseline = isPlainObject(raw.baseline) ? raw.baseline : {}
  const baselineSteps = baseline.steps === undefined ? undefined : Number(baseline.steps)
  const baselineTokens = baseline.tokens === undefined ? undefined : Number(baseline.tokens)
  if (baselineSteps !== undefined && !Number.isFinite(baselineSteps)) fail('baseline.steps 必须是数字')
  if (baselineTokens !== undefined && !Number.isFinite(baselineTokens)) fail('baseline.tokens 必须是数字')

  if (errors.length > 0) return { task: null, errors }

  return {
    task: {
      id,
      taskType,
      title: isNonEmptyString(raw.title) ? raw.title : id,
      task: raw.task,
      severity,
      tags: normalizeStringArray(raw.tags) ?? [],
      repository: {
        mode,
        path: mode === 'worktree' ? (repo.path ?? '.') : undefined,
        ref,
        fixture: mode === 'fixture' ? resolveFixture(repo.fixture, ctx) : undefined,
        setupCommands: normalizeStringArray(repo.setupCommands ?? repo.setup_commands) ?? [],
      },
      verification: { runner, command, failToPass: f2p, passToPass: p2p },
      constraints: { maxSteps, maxWallMs, maxTokenBudget, allowedPaths, forbiddenCommands },
      baseline: { steps: baselineSteps, tokens: baselineTokens },
      /**
       * mock 剧本：CI 门禁模式下驱动确定性模型应答。
       * 这是「固定底层 LLM」的落地方式——评测不赌模型当天的发挥，
       * 只测 Harness 在给定模型输出下的行为。真实任务成功率另走 record 模式。
       */
      mock: isPlainObject(raw.mock) ? raw.mock : undefined,
      /** 该任务的正确答案是否需要委派；未声明时按「不允许」保守处理。 */
      allowsDelegation: raw.allowsDelegation === true,
      scoring,
      file: ctx.file ? resolve(ctx.file) : undefined,
    },
    errors: [],
  }
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 从目录加载任务集（`<dir>/**\\/*.json`）。
 * 跳过：以 `_` 开头的文件、`fixtures/` 与 `node_modules/` 目录、以及 `RESERVED_TASK_FILES` 中的非任务 JSON。
 * @param {{ dir: string, repoRoot: string, ids?: string[] }} opts
 * @returns {Promise<{ tasks: object[], errors: string[], inventory: object }>}
 */
export async function loadTasks(opts) {
  const dir = resolve(opts.dir)
  const repoRoot = resolve(opts.repoRoot ?? process.cwd())
  const errors = []
  const tasks = []
  const files = []

  if (!(await exists(dir))) {
    return { tasks, errors: [`任务目录不存在：${dir}`], inventory: { dir, files: 0, byType: {} } }
  }

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name === 'fixtures' || entry.name === 'node_modules') continue
      if (RESERVED_TASK_FILES.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.json')) files.push(full)
    }
  }
  await walk(dir)
  files.sort()

  const seen = new Set()
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(await readFile(file, 'utf-8'))
    } catch (err) {
      errors.push(`${file}: JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const list = Array.isArray(raw) ? raw : [raw]
    for (const item of list) {
      const { task, errors: errs } = normalizeTask(item, { dir, repoRoot, file })
      if (errs.length > 0) {
        errors.push(...errs)
        continue
      }
      if (seen.has(task.id)) {
        errors.push(`${file}: 任务 id 重复：${task.id}`)
        continue
      }
      seen.add(task.id)

      // 素材存在性：跑之前就暴露「fixture 目录写错」这类低成本错误（路径已在归一化期解析为绝对）
      if (task.repository.mode === 'fixture' && !(await exists(task.repository.fixture))) {
        errors.push(`${file}: fixture 目录不存在：${task.repository.fixture}`)
      }
      tasks.push(task)
    }
  }

  const byType = {}
  for (const t of tasks) byType[t.taskType] = (byType[t.taskType] ?? 0) + 1

  const filtered = opts.ids?.length ? tasks.filter((t) => opts.ids.includes(t.id)) : tasks
  return {
    tasks: filtered,
    errors,
    inventory: { dir, files: files.length, total: tasks.length, selected: filtered.length, byType },
  }
}
