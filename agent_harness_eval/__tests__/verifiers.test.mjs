/**
 * 程序化验证器的单元测试。
 *
 * 这些断言保护的是整套评测的**判定口径**：F2P/P2P 怎么匹配、什么情况算 fail、
 * 什么情况必须诚实地说 unknown。口径一旦被改坏，评测会安静地给出错误结论，
 * 所以这里逐条钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultCommand,
  judgeOutcome,
  parseTap,
  resolveExpectedTests,
  validateVerificationSpec,
} from '../src/verifiers.mjs'

/** 真实 node --test TAP 输出的最小样本（含文件级子测试与 YAML 诊断块）。 */
const TAP_ALL_GREEN = `TAP version 13
# Subtest: math.test.mjs
    # Subtest: sumRange 累加闭区间 1..n
    ok 1 - sumRange 累加闭区间 1..n
      ---
      duration_ms: 1.2
      ...
    1..2
    # Subtest: clamp 夹取到上下界
    ok 2 - clamp 夹取到上下界
      ---
      duration_ms: 0.4
      ...
    1..2
ok 1 - math.test.mjs
  ---
  duration_ms: 12.3
  ...
1..1
# tests 3
# pass 2
# fail 1
`

/** 改动前：F2P 失败、P2P 通过（这正是 F2P 应有的基线形态）。 */
const TAP_F2P_RED = `TAP version 13
# Subtest: math.test.mjs
    # Subtest: sumRange 累加闭区间 1..n
    not ok 1 - sumRange 累加闭区间 1..n
      ---
      duration_ms: 1.1
      ...
    1..2
    # Subtest: clamp 夹取到上下界
    ok 2 - clamp 夹取到上下界
      ---
      duration_ms: 0.3
      ...
    1..2
not ok 1 - math.test.mjs
  ---
  duration_ms: 9.9
  ...
1..1
# tests 3
# pass 1
# fail 2
`

/** 改动后：F2P 转绿，但 P2P 回归了。 */
const TAP_P2P_REGRESSED = `TAP version 13
# Subtest: math.test.mjs
    # Subtest: sumRange 累加闭区间 1..n
    ok 1 - sumRange 累加闭区间 1..n
      ---
      duration_ms: 1.0
      ...
    1..2
    # Subtest: clamp 夹取到上下界
    not ok 2 - clamp 夹取到上下界
      ---
      duration_ms: 0.3
      ...
    1..2
not ok 1 - math.test.mjs
  ---
  duration_ms: 9.0
  ...
1..1
# tests 3
# pass 1
# fail 2
`

/** 期望的 P2P 用例被删除/改名后，TAP 里根本不会出现它。 */
const TAP_P2P_VANISHED = `TAP version 13
# Subtest: math.test.mjs
    # Subtest: sumRange 累加闭区间 1..n
    ok 1 - sumRange 累加闭区间 1..n
      ---
      duration_ms: 1.0
      ...
    1..1
ok 1 - math.test.mjs
  ---
  duration_ms: 8.0
  ...
1..1
# tests 2
# pass 2
# fail 0
`

const SPEC = {
  failToPass: ['sumRange 累加闭区间 1..n'],
  passToPass: ['clamp 夹取到上下界'],
}

/** 复刻 runVerification 的产出形状（去掉真实进程那一层，便于构造边界场景）。 */
function verifyLike(tapText, spec = SPEC) {
  const { tests } = parseTap(tapText)
  return {
    timedOut: false,
    infrastructureFailure: false,
    exitCode: 0,
    hasTap: tests.length > 0,
    tests,
    failToPass: resolveExpectedTests(tests, spec.failToPass ?? []),
    passToPass: resolveExpectedTests(tests, spec.passToPass ?? []),
  }
}

test('parseTap 采信汇总行并识别文件级子测试', () => {
  const { tests, summary } = parseTap(TAP_ALL_GREEN)

  assert.equal(tests.length, 3)
  assert.deepEqual(
    tests.map((t) => t.name),
    ['sumRange 累加闭区间 1..n', 'clamp 夹取到上下界', 'math.test.mjs'],
  )
  assert.equal(tests[2].fileLevel, true)
  assert.equal(tests[0].fileLevel, false)
  // 文件级子测试在样本里是 not ok，但汇总行说 pass 2 / fail 1 —— 汇总行优先
  assert.equal(summary.total, 3)
  assert.equal(summary.pass, 2)
  assert.equal(summary.fail, 1)
  assert.equal(summary.version, 13)
})

test('resolveExpectedTests 精确名 / 归一化名 / 末段名三层匹配', () => {
  const { tests } = parseTap(TAP_ALL_GREEN)

  const exact = resolveExpectedTests(tests, ['sumRange 累加闭区间 1..n'])
  assert.equal(exact.missing.length, 0)
  assert.equal(exact.matched[0].ok, true)
  assert.equal(exact.passedAll, true)

  // 空白折叠 + 去掉尾部括号说明后仍应命中
  const normalized = resolveExpectedTests(tests, ['sumRange   累加闭区间   1..n (2ms)'])
  assert.equal(normalized.missing.length, 0)
  assert.equal(normalized.matched[0].ok, true)

  // 层级名 `文件 > 用例` 取末段匹配
  const leaf = resolveExpectedTests(tests, ['math.test.mjs > clamp 夹取到上下界'])
  assert.equal(leaf.missing.length, 0)
  assert.equal(leaf.matched[0].ok, true)
})

test('resolveExpectedTests 把文件级子测试排除在匹配池外', () => {
  const { tests } = parseTap(TAP_ALL_GREEN)
  const res = resolveExpectedTests(tests, ['math.test.mjs'])

  // 文件名级别的 ok/not ok 不能拿来冒充某条具名用例
  assert.deepEqual(res.missing, ['math.test.mjs'])
  assert.equal(res.matched[0].ok, null)
  assert.equal(res.passedAll, false)
})

test('judgeOutcome：F2P 转绿且 P2P 无回归 → pass', () => {
  const baseline = verifyLike(TAP_F2P_RED)
  const after = verifyLike(TAP_ALL_GREEN)
  const outcome = judgeOutcome(baseline, after, SPEC)

  assert.equal(outcome.verdict, 'pass')
  assert.equal(outcome.signals.failToPass.expected, 1)
  assert.equal(outcome.signals.failToPass.beforePassing, 0)
  assert.equal(outcome.signals.failToPass.afterPassing, 1)
  assert.deepEqual(outcome.signals.regressions, [])
  assert.deepEqual(outcome.signals.vanishedTests, [])
  assert.deepEqual(outcome.signals.nonDiscriminating, [])
})

test('judgeOutcome：F2P 未转绿 → fail', () => {
  const outcome = judgeOutcome(verifyLike(TAP_F2P_RED), verifyLike(TAP_F2P_RED), SPEC)
  assert.equal(outcome.verdict, 'fail')
  assert.match(outcome.reason, /FAIL_TO_PASS 未全部转绿/)
})

test('judgeOutcome：P2P 回归 → fail，且优先于「F2P 全绿」', () => {
  const outcome = judgeOutcome(verifyLike(TAP_ALL_GREEN), verifyLike(TAP_P2P_REGRESSED), SPEC)
  assert.equal(outcome.verdict, 'fail')
  assert.deepEqual(outcome.signals.regressions, ['clamp 夹取到上下界'])
  assert.match(outcome.reason, /PASS_TO_PASS 回归/)
})

test('judgeOutcome：期望用例凭空消失 → fail（防「删断言/删用例」）', () => {
  const outcome = judgeOutcome(verifyLike(TAP_ALL_GREEN), verifyLike(TAP_P2P_VANISHED), SPEC)
  assert.equal(outcome.verdict, 'fail')
  assert.deepEqual(outcome.signals.vanishedTests, ['clamp 夹取到上下界'])
  assert.match(outcome.reason, /验证用例缺失或被移除/)
})

test('judgeOutcome：改动前 F2P 已经绿了 → nonDiscriminating（语料无区分度）', () => {
  const outcome = judgeOutcome(verifyLike(TAP_ALL_GREEN), verifyLike(TAP_ALL_GREEN), SPEC)
  assert.equal(outcome.verdict, 'pass')
  assert.deepEqual(outcome.signals.nonDiscriminating, ['sumRange 累加闭区间 1..n'])
})

test('judgeOutcome：超时记 fail、环境故障记 unknown，均不伪装成正常结论', () => {
  const timedOut = judgeOutcome(verifyLike(TAP_ALL_GREEN), { ...verifyLike(TAP_ALL_GREEN), timedOut: true }, SPEC)
  assert.equal(timedOut.verdict, 'fail')
  assert.match(timedOut.reason, /超时/)

  const infra = judgeOutcome(verifyLike(TAP_ALL_GREEN), {
    ...verifyLike(TAP_ALL_GREEN),
    hasTap: false,
    infrastructureFailure: true,
    exitCode: 1,
  }, SPEC)
  assert.equal(infra.verdict, 'unknown')
  assert.equal(infra.signals.infrastructureFailure, true)

  const missingBaseline = judgeOutcome(null, verifyLike(TAP_ALL_GREEN), SPEC)
  assert.equal(missingBaseline.verdict, 'unknown')
})

test('validateVerificationSpec：拒绝不可信的验证声明', () => {
  assert.equal(validateVerificationSpec({ failToPass: ['x'], command: 'node --test x' }).ok, true)
  assert.equal(validateVerificationSpec({ passToPass: ['x'], runner: 'node-test' }).ok, true)

  const neither = validateVerificationSpec({ command: 'node --test x' })
  assert.equal(neither.ok, false)
  assert.match(neither.errors.join('；'), /至少声明 failToPass 或 passToPass/)

  const noCommand = validateVerificationSpec({ failToPass: ['x'] })
  assert.equal(noCommand.ok, false)

  const unknownRunner = validateVerificationSpec({ failToPass: ['x'], runner: 'mocha' })
  assert.equal(unknownRunner.ok, false)
  assert.match(unknownRunner.errors.join('；'), /未知 runner/)
})

test('defaultCommand：按 runner 生成命令，未知 runner 返回 null', () => {
  assert.equal(defaultCommand('node-test', ['a.test.mjs']), 'node --test --test-reporter=tap a.test.mjs')
  assert.equal(defaultCommand('vitest', ['a.test.ts']), 'npx vitest run --reporter=tap a.test.ts')
  assert.equal(defaultCommand('npm-test'), 'npm test --silent')
  assert.equal(defaultCommand('mocha', ['a.js']), null)
})
