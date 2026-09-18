/**
 * 确定性伪随机源（xorshift32）+ 采样助手。
 * 强制：全流程随机性只允许来自这里，种子写入每份报告，保证可复现。
 */
export function makeRng(seed = 42) {
  let s = (seed >>> 0) || 0x9e3779b9
  return function next() {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

export function pick(rng, arr, index) {
  if (index !== undefined) return arr[((index % arr.length) + arr.length) % arr.length]
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

export function shuffled(rng, arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function range(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i))
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
