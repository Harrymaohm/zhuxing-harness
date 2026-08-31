import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 用户级配置（凭证与默认值），持久化到 ~/.zhuxing-harness/config.json。 */
export interface HarnessConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 应用内更新源地址（自建 HTTP 静态服务，manifest.json + 增量包）。 */
  updateUrl?: string
  [key: string]: unknown
}

/** 配置文件路径（测试可用 HARNESS_CONFIG 覆盖）。 */
export function configPath(): string {
  return process.env.HARNESS_CONFIG ?? join(homedir(), '.zhuxing-harness', 'config.json')
}

export function loadConfig(): HarnessConfig {
  const p = configPath()
  try {
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as HarnessConfig
  } catch {
    return {}
  }
}

export function saveConfig(config: HarnessConfig): string {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return p
}

/** 加载工作区 .env（KEY=VALUE），不覆盖已存在的环境变量。 */
export function loadDotEnv(dir: string): void {
  const p = join(dir, '.env')
  if (!existsSync(p)) return
  const lines = readFileSync(p, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (!(key in process.env)) {
      process.env[key] = value.replace(/^['"]|['"]$/g, '')
    }
  }
}
