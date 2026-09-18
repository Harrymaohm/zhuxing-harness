import { createInterface } from 'node:readline/promises'
import { maskSecrets } from '@zhuxing/harness-kernel'
import { DEFAULT_PERMISSION_LEVEL, PERMISSION_LEVELS } from '@zhuxing/harness-sandbox'
import { loadConfig, saveConfig } from '../config-store.js'
import type { HarnessConfig } from '../config-store.js'
import { fmt, out, outError } from '../output.js'

export async function cmdLogin(): Promise<void> {
  const existing = loadConfig()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const apiKey = (await rl.question(fmt.bold('DeepSeek API Key：'))).trim()
    if (!apiKey) {
      outError('✗ API Key 不能为空')
      process.exitCode = 2
      return
    }
    const baseUrl = (await rl.question(`Base URL [${'https://api.deepseek.com/v1'}]：`)).trim()
    const model = (await rl.question(`模型 [${'deepseek-v4-flash'}]：`)).trim()
    const workspace = (await rl.question(`工作区 [${process.cwd()}]：`)).trim()
    const levelRaw = (
      await rl.question(`沙箱级别 [${DEFAULT_PERMISSION_LEVEL}]（${PERMISSION_LEVELS.join(' | ')}）：`)
    ).trim()

    const next: HarnessConfig = {
      ...existing,
      apiKey,
      baseUrl: baseUrl || 'https://api.deepseek.com/v1',
      model: model || 'deepseek-v4-flash',
      workspace: workspace || process.cwd(),
      level: (levelRaw && (PERMISSION_LEVELS as readonly string[]).includes(levelRaw) ? levelRaw : DEFAULT_PERMISSION_LEVEL) as HarnessConfig['level'],
    }
    const path = saveConfig(next)
    out(`✓ 配置已保存到 ${path}`)
    out(`  模型：${next.model} · 工作区：${next.workspace} · 沙箱：${next.level}`)
  } finally {
    rl.close()
  }
}

export async function cmdConfig(args: string[]): Promise<void> {
  const [sub, key, value] = args
  const cfg = loadConfig()
  switch (sub) {
    case 'get': {
      if (!key) {
        outError('用法：harness config get <key>')
        process.exitCode = 2
        return
      }
      const v = cfg[key]
      out(key === 'apiKey' ? maskSecrets(String(v ?? '')) : String(v ?? '(未设置)'))
      break
    }
    case 'set': {
      if (!key || value === undefined) {
        outError('用法：harness config set <key> <value>')
        process.exitCode = 2
        return
      }
      saveConfig({ ...cfg, [key]: value })
      out(key === 'apiKey' ? `✓ apiKey 已更新（${maskSecrets(value)}）` : `✓ ${key} = ${value}`)
      break
    }
    case 'rm': {
      if (!key) {
        outError('用法：harness config rm <key>')
        process.exitCode = 2
        return
      }
      const { [key]: _removed, ...rest } = cfg
      saveConfig(rest)
      out(`✓ 已移除 ${key}`)
      break
    }
    case 'list': {
      if (Object.keys(cfg).length === 0) {
        out('（配置为空，运行 harness login 配置）')
        return
      }
      for (const [k, v] of Object.entries(cfg)) {
        out(k === 'apiKey' ? `  ${k} = ${maskSecrets(String(v))}` : `  ${k} = ${String(v)}`)
      }
      break
    }
    default:
      outError('用法：harness config <get|set|list|rm> [key] [value]')
      process.exitCode = 2
  }
}
