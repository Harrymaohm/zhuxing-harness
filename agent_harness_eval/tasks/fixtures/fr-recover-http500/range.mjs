/**
 * 演示模块：整数区间与求和。
 * range 存在 off-by-one 缺陷（末项被丢弃）。
 */

/** 生成闭区间 [start, end] 的整数数组。缺陷：使用 `< end` 导致末项丢失。 */
export function range(start, end) {
  const out = []
  for (let i = start; i < end; i += 1) out.push(i)
  return out
}

/** 累加数组元素。本函数无缺陷，用于 PASS_TO_PASS 对照。 */
export function sum(values) {
  return values.reduce((acc, v) => acc + v, 0)
}
