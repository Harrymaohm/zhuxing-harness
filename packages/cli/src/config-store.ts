import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionLevel } from '@zhuxing/harness-sandbox'

/** 用户级配置（凭证与默认值），持久化到 ~/.zhuxing-harness/config.json。 */
export interface HarnessConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  workspace?: string
  level?: PermissionLevel
  /** 应用内更新源地址（自建 HTTP 静态服务，manifest.json + 增量包）。 */
  updateUrl?: string
  /**
   * 插件供应链治理：签名信任清单（keyring）。元素形如 `<别名>:<公钥>` 或裸公钥（ed25519，base64）。
   * 环境变量 `HARNESS_PLUGIN_KEYRING` 优先级更高。配了它，从文件加载的插件就必须通过签名校验。
   */
  plugins?: { trustedKeys?: string[] }
  /**
   * MCP（Model Context Protocol）stdio server 配置，沿用 Claude Desktop / Cursor 的 mcpServers 形状：
   * `{ "<server>": { command, args?, env?, cwd? } }`。
   * 注意：接入 server 等于把它的能力并入 agent，且它运行在外部进程里，路径沙箱管不到它碰什么文件。
   */
  mcpServers?: Record<string, unknown>
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
