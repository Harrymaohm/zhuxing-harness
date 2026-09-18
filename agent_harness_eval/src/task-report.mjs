/**
 * 任务层报告渲染（对齐计划案第八章「评分卡与报告规范」）。
 *
 * 输入是 `runTaskRepeated` 的结果数组，输出三种形态：
 *   - 对象      buildSuiteReport()      机器可读的稳定结构，供 CI 与跨版本比对
 *   - Markdown  renderSuiteMarkdown()   CI artifact / 归档
 *   - 纯文本    renderSuiteText()       终端直读
 *
 * 三条渲染纪律：
 *   ① 只呈现证据能支撑的结论。判定为 unknown 一律照实写，不用 0 分或满分代替。
 *   ② coverage 必须与得分同时出现。部分维度未判定时，禁止只显示归一化分数，
 *      否则「只跑了 outcome」会被读成「全面达标」。
 *   ③ 结论必须可回溯。每个任务都附上判定理由、F2P/P2P 明细、改动清单与证据等级，
 *      任何一处结论都能被独立复算，而不是只留一个分数。
 */

/** 证据等级由高到低，用于报告排序与统计。 */
const EVIDENCE_LEVELS = ['E3', 'E2', 'E1', 'E0']

/** 判定分布的全集：unknown 必须显式占位，避免「没跑」被当成「没失败」。 */
const VERDICTS = ['pass', 'fail', 'unknown']

function pct(x) {
  return typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '-'
}

function num(x, digits = 0) {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '-'
}

/** 汇总一批 run 的网络遥测：成本与用量相加，逐模型保留明细。 */
function sumTelemetry(runs) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, reportedCalls: 0 }
  let amount = 0
  let priced = 0
  let unpriced = 0
  let requests = 0
  let errors = 0
  let upstreamErrors = 0
  const currencies = new Set()
  /** model → {calls, priced, unpriced}：缺费率时要能指出是哪个模型没有费率 */
  const byModel = new Map()

  for (const r of runs) {
    const st = r?.telemetry?.state
    if (!st) continue
    for (const k of Object.keys(usage)) {
      if (typeof st.usage?.[k] === 'number') usage[k] += st.usage[k]
    }
    const c = st.cost
    if (c) {
      if (typeof c.amount === 'number') amount += c.amount
      if (c.currency) currencies.add(c.currency)
      priced += c.priced ?? 0
      unpriced += c.unpriced ?? 0
    }
    // 代理状态里 requests / errors 是明细数组（用于逐调用回溯），这里只取条数
    requests += st.requests?.length ?? 0
    errors += st.errors?.length ?? 0
    upstreamErrors += st.upstreamErrors ?? 0

    for (const req of st.requests ?? []) {
      const m = req?.model ?? 'unknown'
      const e = byModel.get(m) ?? { calls: 0, priced: 0, unpriced: 0 }
      e.calls += 1
      if (req?.cost) e.priced += 1
      else e.unpriced += 1
      byModel.set(m, e)
    }
  }

  const currency = currencies.size === 1 ? [...currencies][0] : currencies.size === 0 ? null : 'MIXED'
  // 一次调用都不可计价时，金额是「未知」而不是 0；混币种时相加无意义，同样标 null。
  const resolvedAmount = priced === 0 || currencies.size > 1 ? null : amount
  return {
    usage,
    cost: {
      amount: resolvedAmount,
      currency: priced === 0 ? null : currency,
      priced,
      unpriced,
      byModel: Object.fromEntries(byModel),
    },
    models: [...byModel.keys()],
    requests,
    errors,
    upstreamErrors,
  }
}

/** 成本渲染：金额未知时明说「未计价」，绝不用 0 冒充。 */
function money(cost) {
  if (!cost || cost.priced === 0) {
    if (!cost?.unpriced) return '未计价'
    const missing = Object.entries(cost.byModel ?? {})
      .filter(([, v]) => v.unpriced > 0)
      .map(([m, v]) => `${m}×${v.unpriced}`)
    return missing.length ? `未计价（缺费率：${missing.join('，')}）` : `未计价（${cost.unpriced} 次调用缺少费率）`
  }
  if (cost.currency === 'MIXED') return `多币种不可加总（已计价 ${cost.priced}）`
  const tail = cost.unpriced > 0 ? `，另有 ${cost.unpriced} 次缺费率` : ''
  return `${cost.currency ?? '-'} ${num(cost.amount, 6)}（已计价 ${cost.priced}${tail}）`
}

/** 单个任务的摘要：把 runs + 评分卡压成报告里的一行（含全部可回溯细节）。 */
export function summarizeTask(result) {
  const runs = result?.runs ?? []
  const primary = runs[0] ?? null
  const verdicts = runs.map((r) => r?.outcome?.verdict ?? 'unknown')
  const manifest = primary?.manifest ?? null

  return {
    taskId: result?.task?.id ?? primary?.taskId ?? null,
    taskType: result?.task?.taskType ?? primary?.taskType ?? null,
    severity: result?.task?.severity ?? null,
    title: result?.task?.title ?? null,
    tags: result?.task?.tags ?? [],
    repeats: runs.length,
    ok: runs.length > 0 && runs.every((r) => r.ok === true),
    verdicts,
    /** 主判定：以首轮为准；多轮不一致时由 robustness 维度显式扣分，不在此处平均 */
    verdict: primary?.outcome?.verdict ?? 'unknown',
    verdictReason: primary?.outcome?.reason ?? null,
    reproducible: result?.reproducible === true,
    evidenceLevel: result?.evidenceLevel ?? null,
    evidenceSignals: primary?.evidenceSignals ?? null,
    card: result?.card ?? null,
    dimensions: Object.fromEntries(
      Object.entries(result?.dimensions ?? {}).map(([k, d]) => [
        k,
        {
          score: typeof d?.score === 'number' ? d.score : null,
          counted: Boolean(d?.counted),
          verdict: d?.verdict ?? 'unknown',
          reason: d?.reason ?? null,
          failing: (d?.checks ?? []).filter((c) => !c.ok).map((c) => ({ id: c.id, severity: c.severity, detail: c.detail })),
        },
      ]),
    ),
    verification: runs.map((r) => ({
      runIndex: r?.runIndex ?? null,
      wallMs: r?.wallMs ?? null,
      baselineDiscrimination: r?.baseline?.discrimination ?? null,
      failToPassBefore: r?.baseline?.failToPass?.matched?.map((m) => ({ name: m.expected, ok: m.ok })) ?? null,
      failToPassAfter: r?.after?.failToPass?.matched?.map((m) => ({ name: m.expected, ok: m.ok })) ?? null,
      passToPassAfter: r?.after?.passToPass?.matched?.map((m) => ({ name: m.expected, ok: m.ok })) ?? null,
    })),
    change: manifest
      ? {
          baselineCommit: manifest.baselineCommit ?? null,
          agentCommits: manifest.agentCommits ?? [],
          totals: manifest.totals ?? null,
          files: (manifest.files ?? []).map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })),
          patchDigest: manifest.patchDigest ?? null,
        }
      : null,
    process: primary?.profile
      ? {
          toolCalls: primary.profile.toolCallCount ?? null,
          unreportedCalls: primary.profile.unreportedCalls ?? null,
          performedWrites: primary.profile.performedWrites ?? null,
          failedToolCalls: primary.profile.failedToolCalls ?? null,
        }
      : null,
    cost: sumTelemetry(runs),
    repoIntegrity: primary?.repoIntegrity?.unchanged ?? null,
    gateFailures: result?.gateFailures ?? [],
    warnings: result?.warnings ?? [],
    errors: result?.errors ?? [],
  }
}

/**
 * 套件级门禁阈值（对齐计划案 7.3 分层门禁）。
 * 默认口径：任何 P0 失败即红灯；不允许「跑挂了也算过」。
 */
export const DEFAULT_GATE = {
  /** 允许的 fail 任务数上限（按判定计数，不是按维度） */
  maxFailures: 0,
  /** 允许的 unknown 任务数上限（跑不起来不能被静默忽略） */
  maxUnknown: 0,
  /** 最低覆盖度：低于此值说明评测面太窄，分数不可信 */
  minCoverage: 0.8,
  /** 最低归一化分数（0–100）；null 表示不设分数门槛 */
  minScore: null,
  /** 是否要求全部任务达到 E3（重复运行一致） */
  requireReproducible: false,
  /** 是否要求仓库工作树未被污染 */
  requireRepoIntegrity: true,
}

/** 汇总套件结果。meta 由调用方提供（CLI 指纹、权限档位、模型、重复次数等）。 */
export function buildSuiteReport({ results, meta = {}, gate = {} }) {
  const tasks = results.map(summarizeTask)
  const thresholds = { ...DEFAULT_GATE, ...gate }

  const verdictCounts = Object.fromEntries(VERDICTS.map((v) => [v, 0]))
  const evidenceCounts = Object.fromEntries(EVIDENCE_LEVELS.map((v) => [v, 0]))
  const byType = {}
  const total = sumTelemetry(results.flatMap((r) => r?.runs ?? []))

  let countedWeight = 0
  let achieved = 0
  let reproducible = 0
  let repoDirty = 0
  const gateFailures = []

  for (const t of tasks) {
    verdictCounts[t.verdict] = (verdictCounts[t.verdict] ?? 0) + 1
    if (t.evidenceLevel && t.evidenceLevel in evidenceCounts) evidenceCounts[t.evidenceLevel] += 1
    byType[t.taskType] = (byType[t.taskType] ?? 0) + 1
    if (t.reproducible) reproducible += 1
    if (t.repoIntegrity === false) repoDirty += 1

    countedWeight += t.card?.countedWeight ?? 0
    achieved += t.card?.rawPoints ?? 0

    for (const f of t.gateFailures) gateFailures.push({ taskId: t.taskId, ...f })
  }

  // 覆盖度分母取各任务评分卡的总权重之和（满分口径），而不是固定 100 × 任务数：
  // 权重表若调整，这里必须跟着变，否则覆盖度会失真。
  const totalWeight = results.reduce((acc, r) => acc + (r?.card?.totalWeight ?? 0), 0)
  const coverage = totalWeight > 0 ? countedWeight / totalWeight : 0
  const normalizedScore = countedWeight > 0 ? (achieved / countedWeight) * 100 : null

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      ...meta,
    },
    aggregate: {
      taskCount: tasks.length,
      passed: verdictCounts.pass,
      failed: verdictCounts.fail,
      unknown: verdictCounts.unknown,
      verdictCounts,
      evidenceCounts,
      reproducibleCount: reproducible,
      repoIntegrityViolations: repoDirty,
      byType,
      coverage,
      normalizedScore,
      grade: normalizedScore === null ? '未判定' : normalizedScore >= 90 ? 'A' : normalizedScore >= 75 ? 'B' : normalizedScore >= 60 ? 'C' : 'D',
      totalCost: total.cost,
      totalUsage: total.usage,
      totalRequests: total.requests,
      totalProxyErrors: total.errors,
      /** 网络层实际观测到的模型名（元数据里的 model 可能是 inherit，不足以说明真实调用） */
      observedModels: total.models,
      thresholds,
    },
    tasks,
    gateFailures,
    gate: { ok: true, reasons: [] },
  }

  report.gate = evaluateSuiteGate(report, thresholds)
  return report
}

/** 门禁判定：所有不达标项逐条列出，不短路、不合并，便于一次性看清全部红灯。 */
export function evaluateSuiteGate(report, thresholds = DEFAULT_GATE) {
  const t = { ...DEFAULT_GATE, ...thresholds }
  const a = report.aggregate
  const reasons = []

  if (a.failed > t.maxFailures) reasons.push(`失败任务 ${a.failed} 个，超过上限 ${t.maxFailures}`)
  if (a.unknown > t.maxUnknown) reasons.push(`无法判定任务 ${a.unknown} 个，超过上限 ${t.maxUnknown}`)
  if (t.minCoverage !== null && a.coverage < t.minCoverage) {
    reasons.push(`覆盖度 ${pct(a.coverage)} 低于门槛 ${pct(t.minCoverage)}：评测面过窄，分数不可信`)
  }
  if (t.minScore !== null && (a.normalizedScore === null || a.normalizedScore < t.minScore)) {
    reasons.push(`归一化得分 ${num(a.normalizedScore, 1)} 低于门槛 ${t.minScore}`)
  }
  if (t.requireReproducible && a.reproducibleCount < a.taskCount) {
    reasons.push(`可复现任务 ${a.reproducibleCount}/${a.taskCount}，未全部满足`)
  }
  if (t.requireRepoIntegrity && a.repoIntegrityViolations > 0) {
    reasons.push(`有 ${a.repoIntegrityViolations} 个任务污染了主仓库工作树`)
  }
  if (report.gateFailures.length > 0) {
    reasons.push(`存在 ${report.gateFailures.length} 项 P0 检查失败`)
  }

  return { ok: reasons.length === 0, reasons }
}

// ------------------------------------------------------------------------- 渲染

function renderTaskBlock(t) {
  const lines = []
  const head = `${t.taskId} [${t.taskType}/${t.severity}] ${t.verdict.toUpperCase()} · 证据 ${t.evidenceLevel ?? '-'} · ${t.repeats} 轮`
  lines.push(head)
  if (t.title) lines.push(`  标题：${t.title}`)
  lines.push(`  判定理由：${t.verdictReason ?? '-'}`)
  for (const v of t.verification) {
    const f2pB = (v.failToPassBefore ?? []).map((m) => `${m.name}=${m.ok}`).join(', ') || '-'
    const f2pA = (v.failToPassAfter ?? []).map((m) => `${m.name}=${m.ok}`).join(', ') || '-'
    const p2pA = (v.passToPassAfter ?? []).map((m) => `${m.name}=${m.ok}`).join(', ') || '-'
    lines.push(`  第 ${v.runIndex} 轮 · 基线区分度 ${v.baselineDiscrimination ?? '-'} · F2P 前 [${f2pB}] → 后 [${f2pA}] · P2P 后 [${p2pA}]`)
  }
  if (t.change) {
    const c = t.change.totals
    lines.push(`  改动：${c ? `${c.files} 文件 +${c.added}/-${c.removed}` : '未采集'}｜${t.change.files.map((f) => `${f.status}:${f.path}`).join(' ') || '无'}`)
  }
  if (t.process) {
    lines.push(`  过程：工具调用 ${t.process.toolCalls}｜未上报 ${t.process.unreportedCalls}｜写操作 ${t.process.performedWrites}｜失败 ${t.process.failedToolCalls}`)
  }
  lines.push(`  成本：${money(t.cost.cost)} · tokens ${t.cost.usage.total_tokens} · 上游请求 ${t.cost.requests}`)
  lines.push(`  评分卡：${num(t.card?.normalizedScore, 1)}（${t.card?.grade ?? '-'}）· 覆盖度 ${pct(t.card?.coverage)} · 原分 ${num(t.card?.rawPoints, 1)}/${t.card?.countedWeight ?? '-'}`)
  const bad = Object.entries(t.dimensions).filter(([, d]) => d.verdict === 'fail' || d.verdict === 'warn')
  for (const [name, d] of bad) {
    lines.push(`    ! ${name}（${d.score}）：${d.reason}`)
    for (const f of d.failing) lines.push(`        - [${f.severity}] ${f.id}：${f.detail ?? ''}`)
  }
  if (t.repoIntegrity === false) lines.push('  ! 主仓库工作树被污染')
  if (t.warnings.length) lines.push(`  警告：${t.warnings.join('｜')}`)
  if (t.errors.length) lines.push(`  错误：${t.errors.join('｜')}`)
  return lines.join('\n')
}

/** 终端直读形态。 */
export function renderSuiteText(report) {
  const a = report.aggregate
  const lines = []
  lines.push(`运行时间：${report.meta.generatedAt}`)
  lines.push(`被测 CLI：${report.meta.cli?.id ?? '-'} ${report.meta.cli?.version ?? '-'} 指纹 ${String(report.meta.cli?.fingerprint ?? '-').slice(0, 12)}`)
  lines.push(`沙箱档位：${report.meta.level ?? '-'}｜模型：${report.meta.model ?? '-'}｜每任务重复：${report.meta.repeats ?? '-'}`)
  lines.push('')
  for (const t of report.tasks) {
    lines.push(renderTaskBlock(t))
    lines.push('')
  }
  lines.push('=== 汇总 ===')
  lines.push(`任务 ${a.taskCount}｜pass ${a.passed}｜fail ${a.failed}｜unknown ${a.unknown}`)
  lines.push(`证据分级：${EVIDENCE_LEVELS.map((l) => `${l} ${a.evidenceCounts[l]}`).join('｜')}｜可复现 ${a.reproducibleCount}/${a.taskCount}`)
  lines.push(`覆盖度 ${pct(a.coverage)}｜归一化得分 ${num(a.normalizedScore, 1)}（${a.grade}）`)
  lines.push(`总成本 ${money(a.totalCost)}｜tokens ${a.totalUsage.total_tokens}｜上游请求 ${a.totalRequests}｜代理错误 ${a.totalProxyErrors}`)
  lines.push(`网络层观测模型：${(a.observedModels ?? []).join('、') || '-'}`)
  if (report.gateFailures.length) {
    lines.push('')
    lines.push('=== 门禁 P0 失败 ===')
    for (const f of report.gateFailures) lines.push(`- ${f.taskId}｜${f.dimension}｜${f.check}：${f.detail ?? ''}`)
  }
  lines.push('')
  lines.push(`门禁：${report.gate.ok ? '通过' : '未通过'}`)
  for (const r of report.gate.reasons) lines.push(`  - ${r}`)
  return lines.join('\n')
}

/** Markdown 形态（CI artifact / 归档）。 */
export function renderSuiteMarkdown(report) {
  const a = report.aggregate
  const lines = []
  lines.push('# Agent Harness 任务层评测报告')
  lines.push('')
  lines.push(`- 运行时间：${report.meta.generatedAt}`)
  lines.push(`- 被测 CLI：\`${report.meta.cli?.id ?? '-'}\` ${report.meta.cli?.version ?? '-'}（指纹 \`${String(report.meta.cli?.fingerprint ?? '-').slice(0, 12)}\`）`)
  lines.push(`- 沙箱档位：\`${report.meta.level ?? '-'}\`｜模型：\`${report.meta.model ?? '-'}\`｜每任务重复：${report.meta.repeats ?? '-'}`)
  if (report.meta.repoFingerprint) {
    lines.push(`- 仓库指纹：\`${report.meta.repoFingerprint.head ?? '-'}\`（工作树改动 ${report.meta.repoFingerprint.dirtyTrackedCount ?? 0}）`)
  }
  if (report.meta.tasksDigest) lines.push(`- 任务集摘要：\`${report.meta.tasksDigest}\``)
  lines.push('')

  lines.push('## 1. 结论')
  lines.push('')
  lines.push(`| 指标 | 值 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 任务数 | ${a.taskCount} |`)
  lines.push(`| pass / fail / unknown | ${a.passed} / ${a.failed} / ${a.unknown} |`)
  lines.push(`| 可复现任务 | ${a.reproducibleCount} / ${a.taskCount} |`)
  lines.push(`| 覆盖度 | ${pct(a.coverage)} |`)
  lines.push(`| 归一化得分 | ${num(a.normalizedScore, 1)}（${a.grade}） |`)
  lines.push(`| 总成本 | ${money(a.totalCost)} |`)
  lines.push(`| 网络层观测模型 | ${(a.observedModels ?? []).join('、') || '-'} |`)
  lines.push(`| 门禁 | ${report.gate.ok ? '通过' : '未通过'} |`)
  lines.push('')
  if (!report.gate.ok) {
    lines.push('未通过原因：')
    for (const r of report.gate.reasons) lines.push(`- ${r}`)
    lines.push('')
  }

  lines.push('## 2. 任务明细')
  lines.push('')
  lines.push('| 任务 | 类型 | 判定 | 证据 | 评分卡 | 覆盖度 | 改动 | 成本 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const t of report.tasks) {
    const c = t.change?.totals
    lines.push(
      `| \`${t.taskId}\` | ${t.taskType} | ${t.verdict} | ${t.evidenceLevel ?? '-'} | ${num(t.card?.normalizedScore, 1)}（${t.card?.grade ?? '-'}） | ${pct(t.card?.coverage)} | ${c ? `${c.files} 文件 +${c.added}/-${c.removed}` : '-'} | ${money(t.cost.cost)} |`,
    )
  }
  lines.push('')

  lines.push('## 3. 六维得分')
  lines.push('')
  lines.push('| 任务 | outcome | compliance | process | cost | changeQuality | robustness |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const t of report.tasks) {
    const cell = (d) => (d ? `${d.score === null ? '未判定' : num(d.score, 2)}（${d.verdict}）` : '-')
    const dims = t.dimensions ?? {}
    lines.push(
      `| \`${t.taskId}\` | ${cell(dims.outcome)} | ${cell(dims.compliance)} | ${cell(dims.process)} | ${cell(dims.cost)} | ${cell(dims.changeQuality)} | ${cell(dims.robustness)} |`,
    )
  }
  lines.push('')
  lines.push('> 未判定表示该维度缺少可判定证据，不计入分母；覆盖度低于 100% 时得分不可与全覆盖任务直接横比。')
  lines.push('')

  if (report.gateFailures.length) {
    lines.push('## 4. P0 门禁失败项')
    lines.push('')
    lines.push('| 任务 | 维度 | 检查项 | 说明 |')
    lines.push('| --- | --- | --- | --- |')
    for (const f of report.gateFailures) lines.push(`| \`${f.taskId}\` | ${f.dimension} | ${f.check} | ${f.detail ?? ''} |`)
    lines.push('')
  }

  lines.push('## 5. 逐任务证据')
  lines.push('')
  for (const t of report.tasks) {
    lines.push(`### ${t.taskId}`)
    lines.push('')
    lines.push('```text')
    lines.push(renderTaskBlock(t))
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染入口：按 format 分派，未知格式直接抛错而不是静默降级。 */
export function renderSuiteReport(report, format = 'text') {
  if (format === 'text') return renderSuiteText(report)
  if (format === 'markdown' || format === 'md') return renderSuiteMarkdown(report)
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  throw new Error(`未知报告格式：${format}（可选 text | markdown | json）`)
}

/** 统计一份报告里任务集的稳定摘要，用于「两次运行是不是同一套题」的比对。 */
export function tasksDigest(tasks) {
  const items = tasks
    .map((t) => `${t.id}@${t.taskType}:${t.verification?.command ?? ''}`)
    .sort()
    .join('\n')
  let h = 2166136261
  for (let i = 0; i < items.length; i += 1) {
    h ^= items.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
