import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, loadDotEnv, saveConfig } from '../src/config-store.js'

const originalConfigPath = process.env.HARNESS_CONFIG
const tempDir = mkdtempSync(join(tmpdir(), 'zhuxing-config-'))

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.HARNESS_CONFIG
  else process.env.HARNESS_CONFIG = originalConfigPath
  delete process.env.TEST_HARNESS_FOO
})

describe('配置持久化（config-store）', () => {
  it('save/load 往返', () => {
    process.env.HARNESS_CONFIG = join(tempDir, 'c.json')
    saveConfig({ apiKey: 'sk-abc123xyz', model: 'm1', workspace: '/tmp/ws' })
    const cfg = loadConfig()
    expect(cfg.model).toBe('m1')
    expect(cfg.workspace).toBe('/tmp/ws')
    expect(cfg.apiKey).toBe('sk-abc123xyz')
  })

  it('loadDotEnv 读取 .env，且不覆盖已有环境变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhuxing-dotenv-'))
    writeFileSync(join(dir, '.env'), 'TEST_HARNESS_FOO=bar\nDEEPSEEK_API_KEY=sk-dotenv123\n')
    process.env.DEEPSEEK_API_KEY = 'existing-key'
    loadDotEnv(dir)
    expect(process.env.TEST_HARNESS_FOO).toBe('bar')
    expect(process.env.DEEPSEEK_API_KEY).toBe('existing-key')
    delete process.env.DEEPSEEK_API_KEY
  })

  it('配置缺失时返回空对象', () => {
    process.env.HARNESS_CONFIG = join(tempDir, 'not-exist.json')
    expect(loadConfig()).toEqual({})
  })
})
