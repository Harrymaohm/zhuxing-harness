import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccount } from './account.mjs'

// PASS_TO_PASS：既有用例。补测时不得改动或删除本用例。
test('deposit 增加余额', () => {
  const acc = createAccount(100)
  assert.equal(acc.deposit(50), 150)
  assert.equal(acc.balance, 150)
})
