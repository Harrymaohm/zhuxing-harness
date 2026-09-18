/**
 * 程序化验证器（计划案 3.3 Outcome 维度 / 核心原则「绝不采信模型自述」）。
 *
 * 这是整套评测里**唯一**判定「任务是否真的完成」的地方，因此它必须只看
 * 真实世界的状态变化：测试进程的退出码与逐条测试结果，而不是 Agent 的结论文本。
 *
 * FAIL_TO_PASS / PASS_TO_PASS 分离（SWE-bench 口径）之所以必要：
 * - FAIL_TO_PASS 在改动前**必须失败**，否则该用例无区分度（说明它测不到目标缺陷）；
 * - PASS_TO_PASS 在改动后**必须仍然通过**，否则是回归。
 * 只跑其中一半都会产生假阳性：只看 F2P 会放过「删掉断言让测试变绿」，
 * 只看 P2P 会放过「什么都没做」。
 */

import { runShell } from './workspace.mjs'

/**
 * 解析 TAP 输出（node --test 与 vitest 的 tap reporter 通用）。
 *
 * 不做层次重建的原因：node --test 的 TAP 是「内层子测试先出现、外层文件级子测试
 * 后闭合」的逆序结构，用栈还原层级极其脆弱。评测只需要「某条具名测试是否通过」，
 * 因此保留 `indent` 与 `name` 即可，不臆造父子关系。
 */
export function parseTap(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const tests = []
  const summary = { total: 0, pass: 0, fail: 0, skip: 0, todo: 0, plan: null, bailout: null, version: null }
  let inYaml = false

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (inYaml) {
      if (body === '...') inYaml = false
      continue
    }
    if (/^---\s*$/.test(body)) {
      inYaml = true
      continue
    }

    if (summary.version === null) {
      const v = body.match(/^TAP version (\d+)/)
      if (v) {
        summary.version = Number(v[1])
        continue
      }
    }

    if (/^Bail out!/i.test(body)) {
      summary.bailout = body.replace(/^Bail out!\s*:?\s*/i, '') || 'bailout'
      continue
    }

    const plan = body.match(/^1\.\.(\d+)/)
    if (plan) {
      summary.plan = Number(plan[1])
      continue
    }

    const m = body.match(/^(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/)
    if (!m) continue

    const okFlag = m[1] === 'ok'
    const num = m[2] ? Number(m[2]) : null
    let desc = (m[3] ?? '').trim()
    let directive = null
    const dirMatch = desc.match(/#\s*(TODO|SKIP)\b\s*(.*)$/i)
    if (dirMatch) {
      directive = { type: dirMatch[1].toUpperCase(), reason: dirMatch[2].trim() }
      desc = desc.slice(0, dirMatch.index).trim()
    }

    const entry = {
      num,
      name: desc,
      ok: okFlag,
      indent,
      skip: directive?.type === 'SKIP',
      todo: directive?.type === 'TODO',
      directive,
      /**
       * 文件级子测试：node --test 的 tap reporter 实际会把所有用例**扁平化**到
       * indent 0（已实测），因此只能靠「描述形如源码文件路径且无 ' > ' 层级」识别。
       * 识别结果仅用于从匹配池里剔除噪声，且调用方有回退保护。
       */
      fileLevel: indent === 0 && /\.(mjs|cjs|js|ts|tsx|jsx)$/.test(desc) && !desc.includes(' > '),
    }
    tests.push(entry)
    summary.total += 1
    if (!okFlag) summary.fail += 1
    else if (entry.skip || entry.todo) summary.skip += 1
    else summary.pass += 1
  }

  // `# tests N` / `# pass N` / `# fail N` 汇总行（node --test 会输出）优先采信
  for (const line of lines) {
    const t = line.trim()
    let mm = t.match(/^#\s*tests\s+(\d+)/)
    if (mm) summary.total = Number(mm[1])
    mm = t.match(/^#\s*pass\s+(\d+)/)
    if (mm) summary.pass = Number(mm[1])
    mm = t.match(/^#\s*fail\s+(\d+)/)
    if (mm) summary.fail = Number(mm[1])
  }

  return { tests, summary }
}

/** 名称归一化：折叠空白、去掉 `file::` 前缀与尾部括号说明。 */
function normalizeName(name) {
  let s = String(name ?? '').trim()
  const sep = s.lastIndexOf('::')
  if (sep >= 0) s = s.slice(sep + 2)
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/\s*\(.*\)\s*$/, '')
  return s.trim()
}

/** 末段名：`a > b > c` → `c`（vitest tap reporter 用 ' > ' 连接）。 */
function leafName(name) {
  const s = String(name ?? '')
  const parts = s.split(/\s*>\s*/)
  return parts[parts.length - 1].trim()
}

/**
 * 把期望的测试名映射到 TAP 实际结果。
 * 匹配顺序：精确 → 归一化 → 末段名。任一层命中即算匹配，避免因报错器
 * 在名字里追加耗时/参数而导致「测试明明跑了却判为缺失」。
 *
 * @returns {{matched: Array<{expected:string, found:string|null, ok:boolean|null}>, missing: string[], passedAll: boolean}}
 */
export function resolveExpectedTests(tests, expected) {
  const list = Array.isArray(expected) ? expected : []
  const pool = tests.filter((t) => !t.fileLevel)
  const usable = pool.length > 0 ? pool : tests
  const usedIndex = new Set()

  const matched = []
  const missing = []

  for (const exp of list) {
    const exact = usable.findIndex((t, i) => !usedIndex.has(i) && t.name === exp)
    let idx = exact
    if (idx < 0) {
      const n = normalizeName(exp)
      idx = usable.findIndex((t, i) => !usedIndex.has(i) && normalizeName(t.name) === n)
    }
    if (idx < 0) {
      const leaf = leafName(normalizeName(exp))
      idx = usable.findIndex((t, i) => !usedIndex.has(i) && leafName(normalizeName(t.name)) === leaf)
    }
    if (idx < 0) {
      missing.push(exp)
      matched.push({ expected: exp, found: null, ok: null })
      continue
    }
    usedIndex.add(idx)
    matched.push({ expected: exp, found: usable[idx].name, ok: usable[idx].ok })
  }

  return {
    matched,
    missing,
    passedAll: missing.length === 0 && matched.every((m) => m.ok === true),
  }
}

/** runner 预设 → 默认命令（任务未显式给 command 时使用）。 */
export function defaultCommand(runner, files) {
  const target = Array.isArray(files) && files.length > 0 ? files.join(' ') : ''
  switch (runner) {
    case 'node-test':
      return `node --test --test-reporter=tap ${target}`.trim()
    case 'vitest':
      return `npx vitest run --reporter=tap ${target}`.trim()
    case 'npm-test':
      return 'npm test --silent'
    default:
      return null
  }
}

/**
 * 执行一次验证。
 *
 * `verdict.infrastructureFailure` 与「测试失败」严格区分：若进程非零退出但 TAP
 * 里一条测试都没有，说明是环境问题（依赖缺失、构建失败），此时**不应**记任务
 * 失败——否则会把环境噪声算成 Harness 的能力缺陷。
 */
export async function runVerification(spec, { cwd, timeoutMs = 600_000, env } = {}) {
  const command = spec.command ?? defaultCommand(spec.runner, spec.files)
  if (!command) {
    return { ok: false, reason: `无法确定验证命令（runner=${spec.runner ?? '未指定'}，且未给 command）` }
  }

  const res = await runShell(command, { cwd, timeoutMs, env })
  const combined = `${res.stdout}\n${res.stderr}`
  const { tests, summary } = parseTap(combined)

  const failToPass = resolveExpectedTests(tests, spec.failToPass ?? [])
  const passToPass = resolveExpectedTests(tests, spec.passToPass ?? [])

  const hasTap = tests.length > 0
  const infrastructureFailure = !res.timedOut && res.code !== 0 && !hasTap

  return {
    ok: true,
    command,
    exitCode: res.code,
    timedOut: res.timedOut,
    wallMs: res.wallMs,
    testCount: tests.length,
    summary,
    tests,
    failToPass,
    passToPass,
    hasTap,
    infrastructureFailure,
    stderrTail: res.stderr.slice(-4_000),
    stdoutTail: res.stdout.slice(-8_000),
  }
}

/**
 * 解析一次验证结果 → Outcome 判定。
 *
 * @param {object} baseline 改动**前**的验证结果（agent 运行前采集）
 * @param {object} after    改动**后**的验证结果
 */
export function judgeOutcome(baseline, after, spec) {
  if (!baseline || !after) {
    return { verdict: 'unknown', reason: '缺少基线或结果，无法判定', signals: {} }
  }
  if (after.timedOut) {
    return { verdict: 'fail', reason: '验证命令超时', signals: {} }
  }
  if (after.infrastructureFailure) {
    return {
      verdict: 'unknown',
      reason: `验证环境故障（退出码 ${after.exitCode}，未产出任何测试结果）`,
      signals: { infrastructureFailure: true },
    }
  }

  const f2p = spec.failToPass ?? []
  const p2p = spec.passToPass ?? []

  const f2pBeforeOk = baseline.failToPass?.matched?.filter((m) => m.ok === true).length ?? 0
  const f2pAfterOk = after.failToPass?.matched?.filter((m) => m.ok === true).length ?? 0
  const p2pBeforeOk = baseline.passToPass?.matched?.filter((m) => m.ok === true).length ?? 0
  const p2pAfterOk = after.passToPass?.matched?.filter((m) => m.ok === true).length ?? 0

  const signals = {
    failToPass: { expected: f2p.length, beforePassing: f2pBeforeOk, afterPassing: f2pAfterOk, missing: after.failToPass?.missing ?? [] },
    passToPass: { expected: p2p.length, beforePassing: p2pBeforeOk, afterPassing: p2pAfterOk, missing: after.passToPass?.missing ?? [] },
    /** 用例无区分度：改动前就已经通过，说明它测的不是目标缺陷。 */
    nonDiscriminating: f2p.length > 0 ? baseline.failToPass.matched.filter((m) => m.ok === true).map((m) => m.expected) : [],
    /** 回归：改动前通过、改动后失败。 */
    regressions: after.passToPass.matched.filter((m) => m.ok === false).map((m) => m.expected),
    /** 期望的测试根本没被跑到（删除/重命名/跳过）。 */
    vanishedTests: [...(after.failToPass.missing ?? []), ...(after.passToPass.missing ?? [])],
  }

  if (signals.vanishedTests.length > 0) {
    return { verdict: 'fail', reason: `验证用例缺失或被移除：${signals.vanishedTests.join(', ')}`, signals }
  }
  if (signals.regressions.length > 0) {
    return { verdict: 'fail', reason: `PASS_TO_PASS 回归：${signals.regressions.join(', ')}`, signals }
  }

  const f2pSatisfied = f2p.length === 0 || after.failToPass.passedAll
  const p2pSatisfied = p2p.length === 0 || after.passToPass.passedAll

  if (f2pSatisfied && p2pSatisfied) {
    return { verdict: 'pass', reason: 'FAIL_TO_PASS 全部转绿且 PASS_TO_PASS 无回归', signals }
  }

  const stillFailing = after.failToPass.matched.filter((m) => m.ok === false).map((m) => m.expected)
  return {
    verdict: 'fail',
    reason: `FAIL_TO_PASS 未全部转绿：${stillFailing.join(', ') || '（无可判定项）'}`,
    signals,
  }
}

/** 校验任务自带的验证声明是否**可信**（防止语料自身写错导致误判）。 */
export function validateVerificationSpec(spec) {
  const errors = []
  if (!spec) {
    errors.push('缺少 verification 声明')
    return { ok: false, errors }
  }
  const hasF2p = Array.isArray(spec.failToPass) && spec.failToPass.length > 0
  const hasP2p = Array.isArray(spec.passToPass) && spec.passToPass.length > 0
  if (!hasF2p && !hasP2p) errors.push('verification 必须至少声明 failToPass 或 passToPass 之一')
  if (!spec.command && !spec.runner) errors.push('verification 必须给出 command 或 runner')
  if (spec.runner && !defaultCommand(spec.runner, spec.files) && !spec.command) {
    errors.push(`未知 runner：${spec.runner}`)
  }
  return { ok: errors.length === 0, errors }
}
