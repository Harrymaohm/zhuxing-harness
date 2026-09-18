import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from './slug.mjs'

// FAIL_TO_PASS：新需求，改动前必然失败。
test('slugify 支持自定义分隔符', () => {
  assert.equal(slugify('Hello World', { separator: '_' }), 'hello_world')
  assert.equal(slugify('a b c', { separator: '.' }), 'a.b.c')
})

test('slugify 支持最大长度截断', () => {
  assert.equal(slugify('alpha beta gamma', { maxLength: 10 }), 'alpha-beta')
  assert.equal(slugify('one two', { maxLength: 100 }), 'one-two')
})

// PASS_TO_PASS：既有行为，改动后不得回归。
test('slugify 默认行为不变', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world')
})
