/**
 * 演示模块：区间求和与数值夹取。
 * sumRange 存在一个 off-by-one 缺陷（循环上界应为闭区间）。
 */

/** 求 1..n 的和。缺陷：使用 `< n` 导致末项被丢弃。 */
export function sumRange(n) {
  let total = 0
  for (let i = 1; i < n; i += 1) total += i
  return total
}

/** 把 value 夹取到 [lo, hi]。本函数无缺陷，用于 PASS_TO_PASS 对照。 */
export function clamp(value, lo, hi) {
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}
