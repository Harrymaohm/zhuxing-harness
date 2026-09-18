import test from 'node:test'
import assert from 'node:assert/strict'
import * as record from './record.mjs'

// FAIL_TO_PASS：重构后解析逻辑应成为可独立调用的导出函数（改动前它不存在）。
test('parseRecord 可直接解析记录串', () => {
  assert.deepEqual(record.parseRecord('a:1;b:2'), { a: 1, b: 2 })
})

// PASS_TO_PASS：既有入口的对外行为不得改变。
test('loadRecord 保持既有行为', () => {
  assert.deepEqual(record.loadRecord('x:7'), { x: 7 })
  assert.deepEqual(record.loadRecord('name:ada; age:36'), { name: 'ada', age: 36 })
})
