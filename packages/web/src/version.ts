import { readFileSync } from 'node:fs'

// ============ 版本 ============

function packageVersion(): string {
  const injected = (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__
  if (injected) return injected
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = packageVersion()
