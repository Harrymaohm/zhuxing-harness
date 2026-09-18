import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generatePluginKeyPair,
  resetPluginTrustNotice,
  signPluginDir,
} from '@zhuxing/harness-kernel'
import { loadPluginModule } from '../src/index.js'

/** 造一个可被 esbuild 转译的最小插件目录。 */
async function makePluginDir(name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-trust-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }, null, 2))
  await writeFile(
    join(dir, 'src', 'index.ts'),
    `export const name = '${name}'\nexport const description = '信任校验用例'\nexport function apply(): void {}\n`,
  )
  return dir
}

const dirs: string[] = []
const originalKeyring = process.env.HARNESS_PLUGIN_KEYRING
const originalConfig = process.env.HARNESS_CONFIG

beforeEach(() => {
  resetPluginTrustNotice()
  process.env.HARNESS_CONFIG = join(tmpdir(), 'harness-trust-absent-config.json')
  delete process.env.HARNESS_PLUGIN_KEYRING
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (originalKeyring === undefined) delete process.env.HARNESS_PLUGIN_KEYRING
  else process.env.HARNESS_PLUGIN_KEYRING = originalKeyring
  if (originalConfig === undefined) delete process.env.HARNESS_CONFIG
  else process.env.HARNESS_CONFIG = originalConfig
})

describe('加载路径的签名校验（config.loadPluginModule）', () => {
  it('配了信任公钥 + 签名正确 → 加载成功', async () => {
    const dir = await makePluginDir('trusted-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    await signPluginDir(dir, pair.privateKeyPem)
    process.env.HARNESS_PLUGIN_KEYRING = `local:${pair.publicKey}`

    const mod = (await loadPluginModule(join(dir, 'src', 'index.ts'))) as { name: string }
    expect(mod.name).toBe('trusted-plugin')
  })

  it('配了信任公钥 + 签名后目录被篡改 → 拒绝加载（原因可读）', async () => {
    const dir = await makePluginDir('tampered-load-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    await signPluginDir(dir, pair.privateKeyPem)
    // 篡改一个字节：把入口文件里的描述改掉
    await writeFile(
      join(dir, 'src', 'index.ts'),
      "export const name = 'tampered-load-plugin'\nexport const description = '被篡改'\nexport function apply(): void {}\n",
    )
    process.env.HARNESS_PLUGIN_KEYRING = pair.publicKey

    await expect(loadPluginModule(join(dir, 'src', 'index.ts'))).rejects.toThrow(/签名校验未通过.*篡改/)
  })

  it('配了信任公钥 + 用另一把密钥签名 → 拒绝加载（公钥不在信任清单）', async () => {
    const dir = await makePluginDir('other-key-load-plugin')
    dirs.push(dir)
    const trusted = generatePluginKeyPair()
    const attacker = generatePluginKeyPair()
    await signPluginDir(dir, attacker.privateKeyPem)
    process.env.HARNESS_PLUGIN_KEYRING = trusted.publicKey

    await expect(loadPluginModule(join(dir, 'src', 'index.ts'))).rejects.toThrow(/不在信任清单/)
  })

  it('配了信任公钥 + 完全未签名 → 拒绝加载', async () => {
    const dir = await makePluginDir('unsigned-load-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    process.env.HARNESS_PLUGIN_KEYRING = pair.publicKey

    await expect(loadPluginModule(join(dir, 'src', 'index.ts'))).rejects.toThrow(/未签名/)
  })

  it('未配信任公钥 → 保持既有行为（允许加载），并提示「签名未校验」', async () => {
    const dir = await makePluginDir('unconfigured-keyring-plugin')
    dirs.push(dir)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const mod = (await loadPluginModule(join(dir, 'src', 'index.ts'))) as { name: string }
    expect(mod.name).toBe('unconfigured-keyring-plugin')
    const notices = warn.mock.calls.map((c) => String(c[0]))
    expect(notices.some((n) => n.includes('未校验'))).toBe(true)
  })
})
