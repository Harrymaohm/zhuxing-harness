import { afterEach } from 'vitest'

/**
 * 测试环境装配。
 *
 * 只在 jsdom 下注册 DOM 相关能力：服务端测试跑在 node 环境，
 * 顶层 import `@testing-library/react` 会因缺少 document 直接抛错。
 */
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => cleanup())
}
