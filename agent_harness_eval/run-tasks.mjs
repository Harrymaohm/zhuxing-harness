#!/usr/bin/env node
/**
 * 任务层评测入口（计划案 4 / 6 / 7 / 8 的落地）。
 *
 * 一次运行做四件事：
 *   ① 定位被测 CLI —— 默认仓库构建产物（回归门禁的语义是「本次改动有没有让 Harness 变差」）
 *   ② 载入任务语料并选择本次要跑的子集
 *   ③ 逐任务隔离执行（建工作区 → 基线验证 → 真跑 CLI → 采集轨迹与网络遥测 → 改动后验证）
 *   ④ 汇总评分卡与门禁，输出 text / markdown / json 三种形态，并以退出码表达门禁结论
 *
 * 用法示例：
 *   node agent_harness_eval/run-tasks.mjs --ids smoke-bugfix-off-by-one --repeats 2
 *   node agent_harness_eval/run-tasks.mjs --types bug_fix,security_boundary --out out-tasks/report
 *   node agent_harness_eval/run-tasks.mjs --list
 *
 * 退出码：0 = 门禁通过；1 = 门禁未通过；2 = 用法/环境错误。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EVAL_ROOT, REPO_ROOT, resolveHarnessCli } from './src/cli-adapter.mjs'
import { TASK_TYPES, loadTasks } from './src/task-schema.mjs'
import { runTaskRepeated } from './src/task-runner.mjs'
import { repoFingerprint } from './src/workspace.mjs'
import {
  DEFAULT_GATE,
  buildSuiteReport,
  renderSuiteReport,
  tasksDigest,
} from './src/task-report.mjs'

const HELP = `任务层评测入口

选项：
  --tasks <目录>        任务语料目录（默认 agent_harness_eval/tasks）
  --ids <a,b>           只跑指定任务 id
  --types <a,b>         只跑指定任务类型（${TASK_TYPES.join(' | ')}）
  --limit <N>           最多跑 N 个任务（按 id 排序后截断）
  --repeats <N>         每个任务重复次数（默认 2；<2 则证据等级封顶 E1）
  --level <级别>        沙箱档位（默认 workspace-write）
  --model <名称>        模型名（默认 inherit=不覆盖，沿用 CLI 配置）
  --cli <路径>          显式指定被测 CLI 入口
  --prefer <repo|installed>  被测 CLI 来源（默认 repo=仓库构建产物）
  --pricing <文件>      费率表（默认 tasks/pricing.json，缺失则成本全部记为未计价）
  --work-base <目录>    隔离工作区根目录（默认 agent_harness_eval/out-tasks）
  --out <目录>          报告落盘目录（默认 <work-base>/report）
  --format <text|markdown|json>   标准输出形态（默认 text）
  --timeout <ms>        单任务 agent 超时上限（默认取任务声明的 maxWallMs）
  --keep-workspace      保留工作区（排障用；默认跑完即拆）
  --min-score <N>       门禁：归一化得分下限
  --min-coverage <0-1>  门禁：覆盖度下限（默认 ${DEFAULT_GATE.minCoverage}）
  --require-reproducible  门禁：要求全部任务达到可复现
  --allow-repo-dirty    门禁：放行主仓库工作树污染
  --no-report           不落盘报告（只打印）
  --list                只列出会被选中的任务，不执行
  --quiet               不打印逐任务进度
  -h, --help            显示本帮助
`

function parseArgs(argv) {
  const opts = {
    tasksDir: join(EVAL_ROOT, 'tasks'),
    ids: [],
    types: [],
    limit: 0,
    repeats: 2,
    level: 'workspace-write',
    model: null,
    cliPath: null,
    prefer: 'repo',
    pricingPath: null,
    workBase: join(EVAL_ROOT, 'out-tasks'),
    out: null,
    format: 'text',
    timeoutMs: null,
    keepWorkspace: false,
    minScore: null,
    minCoverage: DEFAULT_GATE.minCoverage,
    requireReproducible: false,
    requireRepoIntegrity: true,
    writeReport: true,
    list: false,
    quiet: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`选项 ${a} 缺少取值`)
      i += 1
      return v
    }
    const list = () => next().split(',').map((s) => s.trim()).filter(Boolean)

    if (a === '--tasks') opts.tasksDir = resolve(next())
    else if (a === '--ids') opts.ids.push(...list())
    else if (a === '--types') opts.types.push(...list())
    else if (a === '--limit') opts.limit = Math.max(0, Number(next()))
    else if (a === '--repeats') opts.repeats = Math.max(1, Number(next()))
    else if (a === '--level') opts.level = next()
    else if (a === '--model') opts.model = next()
    else if (a === '--cli') opts.cliPath = resolve(next())
    else if (a === '--prefer') opts.prefer = next()
    else if (a === '--pricing') opts.pricingPath = resolve(next())
    else if (a === '--work-base') opts.workBase = resolve(next())
    else if (a === '--out') opts.out = resolve(next())
    else if (a === '--format') opts.format = next()
    else if (a === '--timeout') opts.timeoutMs = Math.max(1, Number(next()))
    else if (a === '--keep-workspace') opts.keepWorkspace = true
    else if (a === '--min-score') opts.minScore = Number(next())
    else if (a === '--min-coverage') opts.minCoverage = Number(next())
    else if (a === '--require-reproducible') opts.requireReproducible = true
    else if (a === '--allow-repo-dirty') opts.requireRepoIntegrity = false
    else if (a === '--no-report') opts.writeReport = false
    else if (a === '--list') opts.list = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '-h' || a === '--help') opts.help = true
    else throw new Error(`未知选项：${a}`)
  }

  if (opts.prefer !== 'repo' && opts.prefer !== 'installed') throw new Error(`--prefer 只能是 repo 或 installed，收到：${opts.prefer}`)
  return opts
}

/** 费率表读取：缺文件不是错误（成本会全部记为未计价），但格式错误必须报错。 */
function loadPricing(path) {
  if (!path || !existsSync(path)) return { pricing: null, source: null }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`费率表解析失败：${path} —— ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (!raw.models || typeof raw.models !== 'object') {
    throw new Error(`费率表缺少 models 字段：${path}`)
  }
  for (const [name, rate] of Object.entries(raw.models)) {
    if (typeof rate?.input !== 'number') throw new Error(`费率表 ${name}.input 必须是数字：${path}`)
    if (rate.output !== undefined && typeof rate.output !== 'number') throw new Error(`费率表 ${name}.output 必须是数字：${path}`)
  }
  return { pricing: raw, source: path }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }

  // ---- ① 被测 CLI ----
  const cliRes = resolveHarnessCli({ cliPath: opts.cliPath ?? undefined, prefer: opts.prefer })
  if (!cliRes.ok) {
    process.stderr.write(`无法定位被测 CLI：${cliRes.reason}\n`)
    for (const t of cliRes.tried) process.stderr.write(`  尝试：${t.id} ${t.path} ok=${t.ok}\n`)
    return 2
  }
  const cli = cliRes.cli

  // ---- ② 任务语料 ----
  const loaded = await loadTasks({ dir: opts.tasksDir, repoRoot: REPO_ROOT, ids: opts.ids.length ? opts.ids : undefined })
  if (loaded.errors.length > 0) {
    process.stderr.write('任务语料存在错误，拒绝执行：\n')
    for (const e of loaded.errors) process.stderr.write(`  - ${e}\n`)
    return 2
  }
  if (opts.ids.length > 0 && loaded.tasks.length !== opts.ids.length) {
    const found = new Set(loaded.tasks.map((t) => t.id))
    const missing = opts.ids.filter((id) => !found.has(id))
    if (missing.length > 0) {
      process.stderr.write(`指定的任务 id 不存在：${missing.join(', ')}\n`)
      return 2
    }
  }

  let selected = loaded.tasks
  if (opts.types.length > 0) {
    const unknown = opts.types.filter((t) => !TASK_TYPES.includes(t))
    if (unknown.length > 0) {
      process.stderr.write(`未知任务类型：${unknown.join(', ')}（可选 ${TASK_TYPES.join(' | ')}）\n`)
      return 2
    }
    selected = selected.filter((t) => opts.types.includes(t.taskType))
  }
  selected = [...selected].sort((a, b) => a.id.localeCompare(b.id))
  if (opts.limit > 0) selected = selected.slice(0, opts.limit)

  if (opts.list) {
    process.stdout.write(`语料目录：${loaded.inventory.dir}（${loaded.inventory.files} 个文件，${loaded.inventory.total} 个任务）\n`)
    for (const t of selected) process.stdout.write(`  ${t.id}\t${t.taskType}\t${t.severity}\t${t.title ?? ''}\n`)
    process.stdout.write(`共选中 ${selected.length} 个\n`)
    return 0
  }
  if (selected.length === 0) {
    process.stderr.write('没有选中任何任务。用 --list 查看可用任务。\n')
    return 2
  }

  // ---- 费率与仓库前置状态 ----
  const pricingPath = opts.pricingPath ?? join(opts.tasksDir, 'pricing.json')
  const { pricing, source: pricingSource } = loadPricing(pricingPath)
  if (!pricing && !opts.quiet) {
    process.stderr.write(`提示：未找到费率表（${pricingPath}），成本将全部记为「未计价」。\n`)
  }

  const repoBefore = await repoFingerprint(REPO_ROOT)
  const outDir = opts.out ?? join(opts.workBase, 'report')

  if (!opts.quiet) {
    process.stderr.write(`被测 CLI：${cli.id} ${cli.version ?? '-'} 指纹 ${String(cli.fingerprint).slice(0, 12)}（${cli.entry}）\n`)
    process.stderr.write(`沙箱档位：${opts.level}｜模型：${opts.model ?? 'inherit'}｜每任务重复：${opts.repeats}｜任务数：${selected.length}\n`)
  }

  // ---- ③ 逐任务执行 ----
  const results = []
  for (const task of selected) {
    if (!opts.quiet) process.stderr.write(`▶ ${task.id} ...`)
    const started = Date.now()
    let res
    try {
      res = await runTaskRepeated({
        task,
        cli,
        repoRoot: REPO_ROOT,
        workBase: opts.workBase,
        repeats: opts.repeats,
        level: opts.level,
        model: opts.model ?? undefined,
        pricing: pricing ?? undefined,
        timeoutMs: opts.timeoutMs ?? undefined,
        keepWorkspace: opts.keepWorkspace,
      })
    } catch (err) {
      // 单个任务抛异常不得吞掉整批：转成 failedRun 形态，让报告里出现一条显式的 unknown
      const message = err instanceof Error ? err.message : String(err)
      res = {
        task,
        runs: [
          {
            taskId: task.id,
            taskType: task.taskType,
            runIndex: 1,
            ok: false,
            reason: `任务执行器抛出异常：${message}`,
            errors: [message],
            warnings: [],
          },
        ],
        dimensions: {},
        robustness: null,
        card: null,
        evidenceLevel: 'E0',
        reproducible: false,
        gateFailures: [],
        warnings: [],
        errors: [message],
      }
    }
    results.push(res)
    if (!opts.quiet) {
      const verdict = res.card ? (res.runs[0]?.outcome?.verdict ?? 'unknown') : 'unknown'
      process.stderr.write(` ${verdict} 得分 ${res.card ? res.card.normalizedScore?.toFixed(1) : '-'} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    }
  }

  const repoAfter = await repoFingerprint(REPO_ROOT)

  // ---- ④ 报告与门禁 ----
  const report = buildSuiteReport({
    results,
    meta: {
      cli: {
        id: cli.id,
        label: cli.label,
        entry: cli.entry,
        version: cli.version,
        fingerprint: cli.fingerprint,
        fingerprintScope: cli.fingerprintScope,
        nodeBundled: cli.nodeBundled,
      },
      level: opts.level,
      model: opts.model ?? 'inherit',
      repeats: opts.repeats,
      tasksDir: loaded.inventory.dir,
      tasksDigest: tasksDigest(selected),
      pricingSource,
      repoFingerprint: { head: repoBefore.head, dirtyTrackedCount: repoBefore.dirtyTrackedCount, statusDigest: repoBefore.statusDigest },
      repoUnchangedDuringRun: repoBefore.statusDigest === repoAfter.statusDigest && repoBefore.head === repoAfter.head,
      gate: {
        maxFailures: DEFAULT_GATE.maxFailures,
        maxUnknown: DEFAULT_GATE.maxUnknown,
        minCoverage: opts.minCoverage,
        minScore: opts.minScore,
        requireReproducible: opts.requireReproducible,
        requireRepoIntegrity: opts.requireRepoIntegrity,
      },
    },
    gate: {
      minCoverage: opts.minCoverage,
      minScore: opts.minScore,
      requireReproducible: opts.requireReproducible,
      requireRepoIntegrity: opts.requireRepoIntegrity,
    },
  })

  // 主仓库在评测期间被改动 = 隔离失效，必须停下来而不是记一条警告
  if (!report.meta.repoUnchangedDuringRun) {
    report.gate.ok = false
    report.gate.reasons.push('评测期间主仓库工作树发生变化：隔离机制失效，本次结果不可信')
  }

  process.stdout.write(`${renderSuiteReport(report, opts.format)}\n`)

  if (opts.writeReport) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'suite-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    writeFileSync(join(outDir, 'suite-report.md'), `${renderSuiteReport(report, 'markdown')}\n`, 'utf-8')
    if (!opts.quiet) process.stderr.write(`报告已写入：${join(outDir, 'suite-report.json')} / suite-report.md\n`)
  }

  return report.gate.ok ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write('用 --help 查看用法。\n')
    process.exitCode = 2
  },
)
