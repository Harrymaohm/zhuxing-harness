import { useEffect, useState } from 'react'

/**
 * 输入防抖：值停止变化 delay 毫秒后才输出。
 * 用于搜索框——每敲一个字符就打一次后端的浪费要消灭掉
 * （连敲 5 字只应产生 1 次请求）。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
