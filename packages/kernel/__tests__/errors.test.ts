import { describe, expect, it } from 'vitest'
import { HarnessError, maskSecrets } from '../src/errors.js'

describe('HarnessError 结构化错误', () => {
  it('HarnessError.from 启发式分类：AUTH', () => {
    const he = HarnessError.from(new Error('HTTP 401 unauthorized: invalid api key'))
    expect(he.code).toBe('AUTH')
    expect(he.hint).toContain('harness login')
  })

  it('HarnessError.from 启发式分类：NETWORK / TIMEOUT / PERMISSION / PLUGIN', () => {
    expect(HarnessError.from(new Error('fetch failed, ConnectTimeoutError')).code).toBe('NETWORK')
    expect(HarnessError.from(new Error('模型请求超时（30000ms）')).code).toBe('TIMEOUT')
    expect(HarnessError.from(new Error('read-only 策略禁止写入')).code).toBe('PERMISSION')
    expect(HarnessError.from(new Error('插件 "x" 挂载失败：依赖缺失')).code).toBe('PLUGIN')
    expect(HarnessError.from(new Error('something unknown')).code).toBe('UNKNOWN')
  })

  it('保留已有 HarnessError', () => {
    const original = new HarnessError('x', 'CONFIG', 'hint')
    expect(HarnessError.from(original)).toBe(original)
  })
})

describe('输出脱敏', () => {
  it('打码 sk- 前缀 Key，保留首尾辨识', () => {
    const masked = maskSecrets('使用 sk-abcdef1234567890 访问')
    expect(masked).toContain('sk-***890')
    expect(masked).not.toContain('abcdef123456')
  })

  it('打码 KEY=VALUE 形式', () => {
    const masked = maskSecrets('DEEPSEEK_API_KEY=sk-abcdef1234567890')
    expect(masked).not.toContain('abcdef123456')
  })

  it('短令牌不做掩码（避免误伤）', () => {
    expect(maskSecrets('sk-abc123')).toBe('sk-abc123')
  })

  it('空输入安全', () => {
    expect(maskSecrets('')).toBe('')
    expect(maskSecrets(undefined as unknown as string)).toBe('')
  })
})
