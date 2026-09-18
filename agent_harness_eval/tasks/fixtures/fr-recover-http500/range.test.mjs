import test from 'node:test'
import assert from 'node:assert/strict'
import { range, sum } from './range.mjs'

// FAIL_TO_PASS：闭区间语义，改动前末项必然丢失。
test('range 生成闭区间 [start, end]', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3])
  assert.deepEqual(range(4, 4), [4])
})

// PASS_TO_PASS：与本任务无关的既有行为，改动后不得回归。
test('sum 累加数组元素', () => {
  assert.equal(sum([1, 2, 3]), 6)
})
