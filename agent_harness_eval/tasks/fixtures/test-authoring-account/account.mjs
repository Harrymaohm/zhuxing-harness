/**
 * 演示模块：极简账户模型。
 * 供「测试补全」任务使用——实现本身没有缺陷，缺的是覆盖 withdraw 边界的用例。
 */

/** 创建一个账户。 */
export function createAccount(initial = 0) {
  let balance = initial
  return {
    get balance() {
      return balance
    },
    deposit(amount) {
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('deposit 金额必须为正数')
      balance += amount
      return balance
    },
    withdraw(amount) {
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('withdraw 金额必须为正数')
      if (amount > balance) throw new Error('余额不足')
      balance -= amount
      return balance
    },
  }
}
