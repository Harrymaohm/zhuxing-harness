/**
 * 任务执行器：把前面六个模块编排成一条**可复算**的单任务流水线。
 *
 * 编排顺序即证据链顺序。任何一步失败都不允许跳到下一步「补一个漂亮结论」：
 *
 *   仓库指纹(before) → 建隔离工作区 → 改动前基线验证 → 固化基线
 *   → 起代理并 reset → spawn 真实 CLI → 采集轨迹 + 网络遥测 → 采集改动清单
 *   → 改动后验证 → judgeOutcome(F2P/P2P) → 五维评估 → 证据分级 → 评分卡
 *   → 拆工作区 → 仓库指纹(after)
 *
 * 三条硬约束：
 *
 * 1. **基线验证必须在 Agent 动手之前跑**。没有「改动前」的对照，就无法区分
 *    「任务真的没做」与「这条用例本来就不可能过」——FAIL_TO_PASS 的语义正是
 *    「改动前失败、改动后通过」，缺了前一半，判定会退化成「测试文件里现在有没有绿」，
 *    而「删掉断言让测试变绿」恰好能满足后半句。
 *
 * 2. **改动清单必须在改动后验证之前采集**。验证本身会写文件（快照、缓存、日志），
 *    先采集才不会被验证自己的副作用污染「Agent 究竟改了什么」。
 *
 * 3. **重复运行之间必须 reset 代理账本**。否则第 2 轮会背上第 1 轮的 token 与成本，
 *    稳定性评估会得出「耗时稳定、用量翻倍」这种纯粹由编排错误造成的结论。
 */

import { join } from 'node:path'

import { runHarnessTask } from './cli-adapter.mjs'
import { CANARY_API_KEY, startTelemetryProxy } from './telemetry-proxy.mjs'
import { parseTrajectory, profileProcess } from './trajectory.mjs'
import {
  collectChangeManifest,
  git,
  makeWorkspacePath,
  prepareWorkspace,
  repoFingerprint,
  teardownWorkspace,
} from './workspace.mjs'
import { judgeOutcome, runVerification, validateVerificationSpec } from './verifiers.mjs'
import {
  evaluateChangeQuality,
  evaluateCompliance,
  evaluateCost,
  evaluateOutcome,
  evaluateProcess,
  evaluateRobustness,
  gradeTaskEvidence,
  scoreTaskCard,
} from './evaluators.mjs'

/** 默认的 mock 兜底剧本：模型什么都不做，只回一句结束语。 */
const NOOP_SCRIPT = { fallback: { content: '任务已完成。' } }

function safeSeg(text) {
  return String(text).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)
}

/** 任务里的 verification 声明 → 验证器可直接消费的 spec。 */
export function verificationSpecOf(task) {
  const v = task?.verification ?? {}
  return {
    runner: v.runner,
    command: v.command,
    failToPass: v.failToPass ?? [],
    passToPass: v.passToPass ?? [],
  }
}

/**
 * 冻结「验证自身的副作用」到基线里。
 *
 * 基线验证会真的执行测试，而测试可能写出快照、覆盖率目录、缓存等文件。这些
 * 属于**评测基础设施的痕迹**，不是 Agent 的交付物；若不冻结，它们会出现在改动
 * 清单里，让「改动质量」凭空背上噪声，甚至触发 no-generated-noise 误判。
 */
async function refreezeBaseline(dir, fallbackCommit) {
  await git(['config', 'user.email', 'eval@harness.local'], { cwd: dir })
  await git(['config', 'user.name', 'harness-eval'], { cwd: dir })
  await git(['config', 'commit.gpgsign', 'false'], { cwd: dir })
  await git(['add', '-A'], { cwd: dir })
  const dirty = await git(['status', '--porcelain=v1'], { cwd: dir })
  if (dirty.stdout.trim()) {
    await git(['commit', '-q', '-m', 'eval: pre-run verification residue'], { cwd: dir })
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir })
  return head.stdout.trim() || fallbackCommit
}

/**
 * 抓取代理账本快照。
 *
 * 刻意复制而非返回代理对象本身：评估器拿到的是**某一轮运行的事实**，
 * 不是「一个还会继续变化的活对象」。否则报告里第 1 轮的成本会随第 2 轮运行而改变。
 */
export function captureTelemetry(proxy) {
  const s = proxy.state
  return {
    mode: s.mode,
    state: {
      usage: { ...s.usage },
      cost: { ...s.cost },
      requests: s.requests.map((r) => ({ ...r })),
      errors: [...s.errors],
      upstreamErrors: s.upstreamErrors,
    },
  }
}

/** 汇总各维度的 P0 失败项，作为评分卡的否决记录。 */
function collectGateFailures(dimensions) {
  const out = []
  for (const [name, dim] of Object.entries(dimensions)) {
    for (const check of dim?.checks ?? []) {
      if (!check.ok && check.severity === 'P0') out.push({ dimension: name, check: check.id, detail: check.detail, evidence: check.evidence ?? null })
    }
  }
  return out
}

function failedRun({ task, runIndex, dir, reason, errors = [], wallMs = 0 }) {
  return {
    taskId: task?.id ?? null,
    taskType: task?.taskType ?? null,
    runIndex,
    ok: false,
    dir,
    reason,
    errors,
    wallMs,
    baseline: null,
    after: null,
    outcome: { verdict: 'unknown', reason, signals: {} },
    traj: null,
    profile: null,
    manifest: null,
    telemetry: null,
    run: null,
    repoIntegrity: null,
    dimensions: {},
    evidenceSignals: { hasTrajectory: false, hasDiff: false, hasPolicy: false, hasExternalTest: false },
    evidenceLevel: 'E0',
  }
}

/**
 * 执行单个任务的一次运行。
 *
 * @param {{
 *   task: object,                      归一化后的任务定义
 *   cli: object,                       resolveHarnessCli 的结果
 *   repoRoot: string,
 *   workBase: string,                  隔离区根目录（工作树 / 会话 / 配置都在其下）
 *   runIndex?: number,
 *   proxy: object,                     startTelemetryProxy 的返回（跨轮复用）
 *   baseline?: object|null,            改动前的验证结果；给出则跳过基线验证
 *   level?: string,                    权限档位
 *   model?: string,
 *   timeoutMs?: number,                Agent 运行的墙钟上限
 *   keepWorkspace?: boolean,
 * }} opts
 */
export async function runTask(opts) {
  const {
    task,
    cli,
    repoRoot,
    workBase,
    runIndex = 1,
    proxy,
    level = 'workspace-write',
    model,
    keepWorkspace = false,
  } = opts

  if (!task) throw new Error('runTask 需要归一化后的 task')
  if (!proxy) throw new Error('runTask 需要已启动的遥测代理（保证成本数据来自网络层）')

  const startedAt = Date.now()
  const spec = verificationSpecOf(task)
  const specCheck = validateVerificationSpec(spec)
  if (!specCheck.ok) {
    return failedRun({ task, runIndex, dir: null, reason: `任务验证声明不可信：${specCheck.errors.join('；')}`, errors: specCheck.errors })
  }

  const dir = makeWorkspacePath(workBase, task.id, runIndex)
  const sessionDir = join(workBase, '_sessions', `${safeSeg(task.id)}__r${runIndex}`)
  const configDir = join(workBase, '_config', `${safeSeg(task.id)}__r${runIndex}`)
  const errors = []
  const warnings = []

  const repoBefore = await repoFingerprint(repoRoot)
  const ws = await prepareWorkspace({ task, dir, repoRoot })
  if (!ws.ok) {
    return failedRun({ task, runIndex, dir, reason: ws.reason, errors: ws.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.stderr}`) })
  }

  try {
    // ---- ① 改动前基线验证：F2P 的「前一半」 ----
    let baseline = opts.baseline ?? null
    if (!baseline) {
      baseline = await runVerification(spec, { cwd: dir, timeoutMs: task.constraints.maxWallMs })
      if (!baseline.ok) {
        return failedRun({ task, runIndex, dir, reason: `基线验证无法执行：${baseline.reason}` })
      }
      if (baseline.infrastructureFailure) {
        baseline = { ...baseline, discrimination: 'environment-failure' }
        warnings.push('基线验证非零退出且未产出任何测试结果：环境缺依赖，本任务判定不可信')
      } else {
        const alreadyGreen = baseline.failToPass?.matched?.filter((m) => m.ok === true).map((m) => m.expected) ?? []
        if (alreadyGreen.length > 0) {
          baseline = { ...baseline, discrimination: 'non-discriminating' }
          warnings.push(`改动前即有 FAIL_TO_PASS 用例通过（无区分度，语料需修）：${alreadyGreen.join(', ')}`)
        } else {
          baseline = { ...baseline, discrimination: 'ok' }
        }
        if (baseline.failToPass?.missing?.length) {
          warnings.push(`改动前缺失期望用例：${baseline.failToPass.missing.join(', ')}`)
        }
      }
    }

    // 基线验证的副作用归入基线，避免污染「Agent 改了什么」
    const baselineCommit = await refreezeBaseline(dir, ws.baselineCommit)

    // ---- ② 单轮账本清零 + 剧本装载 ----
    proxy.reset()
    proxy.setScript(task.mock ?? NOOP_SCRIPT)
    // 故障注入随任务声明装载（failure_recovery 类型靠它制造真实的上游异常）。
    // 每轮都必须重装：fired 计数在 reset 之外，跨轮复用会让第 2 轮无故障可注入。
    proxy.setFaults(task.mock?.faults ?? [])

    // ---- ③ 动真格：spawn 本地已安装的 CLI ----
    const raw = await runHarnessTask({
      cli,
      task: task.task,
      workspace: dir,
      sessionDir,
      configDir,
      baseUrl: proxy.baseUrl,
      apiKey: CANARY_API_KEY,
      model,
      level,
      maxSteps: task.constraints.maxSteps,
      timeoutMs: opts.timeoutMs ?? task.constraints.maxWallMs,
    })
    const run = { ...raw, permissionLevel: level }
    const telemetry = captureTelemetry(proxy)

    if (raw.timedOut) warnings.push(`Agent 运行超时（${task.constraints.maxWallMs} ms 上限）`)
    if (raw.spawnError) errors.push(`CLI 启动失败：${raw.spawnError}`)
    if (raw.parseError) warnings.push(`stdout 结果契约解析失败：${raw.parseError}`)

    // ---- ④ 轨迹 + 过程画像 ----
    const traj = parseTrajectory(run.trace?.events ?? [])
    const profile = profileProcess(traj, {
      reportedSteps: typeof run.result?.steps === 'number' ? run.result.steps : null,
      networkCalls: telemetry.state.usage.calls,
      wallMs: run.wallMs,
    })

    // ---- ⑤ 改动清单（必须在改动后验证之前） ----
    const manifest = await collectChangeManifest(dir, baselineCommit)

    // ---- ⑥ 改动后验证 + 判定 ----
    const after = await runVerification(spec, { cwd: dir, timeoutMs: task.constraints.maxWallMs })
    const outcome = judgeOutcome(baseline, after, spec)

    // ---- ⑦ 五维评估 ----
    const repoAfter = await repoFingerprint(repoRoot)
    const repoIntegrity = {
      before: repoBefore,
      after: repoAfter,
      unchanged:
        repoBefore.head === repoAfter.head &&
        repoBefore.statusDigest === repoAfter.statusDigest &&
        repoBefore.stashCount === repoAfter.stashCount,
    }

    const dimensions = {
      outcome: evaluateOutcome(outcome, { run, testsRun: after.testCount ?? null }),
      compliance: evaluateCompliance({ task, traj, manifest, proxy: telemetry, run, repoIntegrity }),
      process: evaluateProcess({ profile, traj, outcome, task }),
      cost: evaluateCost({ proxy: telemetry, task, baselineTokens: task.baseline?.tokens ?? null }),
      changeQuality: evaluateChangeQuality({ manifest, task, outcome }),
    }

    const evidenceSignals = {
      hasTrajectory: traj.messages.length > 0 || traj.toolCalls.length > 0,
      hasDiff: manifest.ok === true,
      hasPolicy: typeof run.permissionLevel === 'string' && (dimensions.compliance.checks?.length ?? 0) > 0,
      hasExternalTest: after.hasTap === true && outcome.verdict !== 'unknown',
    }
    // 单次运行一律不标可复现（沿用既有规则：reproducible 必须由 ≥2 次同条件重放证明）
    const evidenceLevel = gradeTaskEvidence({ ...evidenceSignals, reproducible: opts.reproducible === true })

    return {
      taskId: task.id,
      taskType: task.taskType,
      runIndex,
      ok: true,
      dir,
      reason: null,
      errors,
      warnings,
      wallMs: Date.now() - startedAt,
      workspace: { mode: ws.mode, dir, baselineCommit, steps: ws.steps },
      baseline,
      after,
      outcome,
      traj,
      profile,
      manifest,
      telemetry,
      run,
      repoIntegrity,
      dimensions,
      evidenceSignals,
      evidenceLevel,
      timings: { agentMs: run.wallMs, verifyMs: after.wallMs, verifyBaselineMs: baseline.wallMs },
    }
  } finally {
    // 幂等拆除：失败路径上也必须回收工作树，否则下一轮 worktree add 会因目录占用失败
    if (!keepWorkspace) await teardownWorkspace({ mode: ws.mode, dir, repoRoot })
  }
}

/**
 * 重复运行同一任务并给出稳定性结论。
 *
 * 基线验证只跑一次：它是**任务语料的属性**，不是 Harness 的属性；每轮重跑
 * 既浪费时间，又会引入「基线本身抖动」这个与被测物无关的变量。
 *
 * @param {Parameters<typeof runTask>[0] & { repeats?: number, pricing?: object, mode?: string, upstream?: object }} opts
 */
export async function runTaskRepeated(opts) {
  const { task, repeats = 1, proxy: externalProxy } = opts
  const ownProxy = !externalProxy
  const proxy =
    externalProxy ??
    (await startTelemetryProxy({
      mode: opts.mode ?? 'mock',
      script: task.mock ?? NOOP_SCRIPT,
      pricing: opts.pricing,
      upstream: opts.upstream,
    }))

  const runs = []
  let baseline = null
  try {
    for (let i = 1; i <= repeats; i += 1) {
      const r = await runTask({ ...opts, runIndex: i, baseline, proxy })
      if (!baseline && r.baseline && r.baseline.discrimination === 'ok') baseline = r.baseline
      runs.push(r)
    }
  } finally {
    if (ownProxy) await proxy.stop()
  }

  const robustness = evaluateRobustness({
    runs: runs.map((r) => ({
      runIndex: r.runIndex,
      outcome: r.outcome,
      wallMs: r.wallMs,
      networkUsage: r.telemetry?.state?.usage ?? null,
    })),
    repeats,
  })

  const primary = runs[0]
  const dimensions = { ...primary.dimensions, robustness }
  const gateFailures = collectGateFailures(dimensions)

  // 可复现性由「≥2 轮同条件重放且结论一致」证明；未满足则证据等级压在 E1
  const verdicts = runs.map((r) => r.outcome?.verdict ?? 'unknown')
  const reproducible = runs.length >= 2 && new Set(verdicts).size === 1
  const evidenceLevel = gradeTaskEvidence({ ...primary.evidenceSignals, reproducible })

  const card = scoreTaskCard(dimensions, {
    taskId: task.id,
    taskType: task.taskType,
    evidenceLevel,
    gateFailures,
  })

  return {
    task,
    runs,
    dimensions,
    robustness,
    card,
    evidenceLevel,
    reproducible,
    gateFailures,
    warnings: [...new Set(runs.flatMap((r) => r.warnings ?? []))],
    errors: [...new Set(runs.flatMap((r) => r.errors ?? []))],
  }
}

export { scoreTaskCard, evaluateRobustness }
