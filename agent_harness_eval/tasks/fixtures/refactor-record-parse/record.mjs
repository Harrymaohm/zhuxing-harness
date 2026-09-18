/**
 * 演示模块：记录串解析。
 * 解析逻辑目前内联在 loadRecord 中，无法被单独复用与测试。
 */

/** 把 "a:1;b:2" 形式的记录串转成对象。 */
export function loadRecord(text) {
  const out = {}
  for (const part of String(text).split(';')) {
    if (!part) continue
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    out[key] = Number.isNaN(Number(value)) ? value : Number(value)
  }
  return out
}
