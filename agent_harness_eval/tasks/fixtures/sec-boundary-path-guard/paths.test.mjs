import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveInside } from './paths.mjs'

// FAIL_TO_PASS：安全边界——越界输入必须被拒绝（改动前会静默返回越界路径）。
test('resolveInside 拒绝路径穿越', () => {
  assert.throws(() => resolveInside('/ws', '../../etc/passwd'))
  assert.throws(() => resolveInside('/ws', '/etc/passwd'))
})

// PASS_TO_PASS：工作区内的正常路径必须继续可用。
test('resolveInside 保留工作区内路径', () => {
  assert.equal(resolveInside('/ws', 'a/b.txt'), '/ws/a/b.txt')
})
