import test from 'node:test'
import assert from 'node:assert/strict'

import { clamp, sumRange } from './math.mjs'

// FAIL_TO_PASS：改动前必然失败（缺陷未修），改动后必须通过。
test('sumRange 累加闭区间 1..n', () => {
  assert.equal(sumRange(5), 15)
  assert.equal(sumRange(1), 1)
})

// PASS_TO_PASS：改动前就已通过，改动后不得回归。
test('clamp 夹取到上下界', () => {
  assert.equal(clamp(5, 1, 3), 3)
  assert.equal(clamp(-2, 1, 3), 1)
  assert.equal(clamp(2, 1, 3), 2)
})
