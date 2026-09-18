import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_SIGNATURE_FILE,
  computePluginDirDigest,
  fingerprintPublicKey,
  generatePluginKeyPair,
  keyringFromEnv,
  parseKeyring,
  resetPluginTrustNotice,
  signPluginDir,
  verifyPluginDir,
  verifyPluginEntryFile,
} from '../src/index.js'

/** 造一个最小插件目录：package.json + src/index.ts（可含自定义文件用于篡改用例）。 */
async function makePluginDir(name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sig-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }, null, 2))
  await writeFile(join(dir, 'src', 'index.ts'), `export const name = '${name}'\nexport function apply() {}\n`)
  return dir
}

const dirs: string[] = []
const originalKeyring = process.env.HARNESS_PLUGIN_KEYRING
const originalConfig = process.env.HARNESS_CONFIG

beforeEach(() => {
  resetPluginTrustNotice()
  // 隔离开发者本机配置：避免 ~/.zhuxing-harness/config.json 里的 plugins.trustedKeys 影响判定
  process.env.HARNESS_CONFIG = join(tmpdir(), 'harness-sig-absent-config.json')
  delete process.env.HARNESS_PLUGIN_KEYRING
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (originalKeyring === undefined) delete process.env.HARNESS_PLUGIN_KEYRING
  else process.env.HARNESS_PLUGIN_KEYRING = originalKeyring
  if (originalConfig === undefined) delete process.env.HARNESS_CONFIG
  else process.env.HARNESS_CONFIG = originalConfig
})

describe('插件签名：密钥对与目录摘要', () => {
  it('生成 ed25519 密钥对：私钥为 PKCS#8 PEM，公钥指纹可复算', () => {
    const pair = generatePluginKeyPair()
    expect(pair.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----')
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9+/=]{43,44}$/) // 裸 32 字节公钥 base64
    expect(pair.keyId).toBe(fingerprintPublicKey(pair.publicKey))
    expect(pair.keyId).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('目录摘要稳定、覆盖全部参与文件，且不因重复签名而漂移（签名文件自身不参与）', async () => {
    const dir = await makePluginDir('digest-plugin')
    dirs.push(dir)
    const before = await computePluginDirDigest(dir)
    expect(before.files.sort()).toEqual(['package.json', 'src/index.ts'])

    const pair = generatePluginKeyPair()
    await signPluginDir(dir, pair.privateKeyPem)
    const afterFirst = await computePluginDirDigest(dir)
    expect(afterFirst.digest).toBe(before.digest)

    await signPluginDir(dir, pair.privateKeyPem)
    const afterSecond = await computePluginDirDigest(dir)
    expect(afterSecond.digest).toBe(before.digest)
  })

  it('排除规则：node_modules / dist / .harness-cache / .git / *.map / *.tsbuildinfo 不参与摘要', async () => {
    const dir = await makePluginDir('exclude-plugin')
    dirs.push(dir)
    const before = await computePluginDirDigest(dir)
    for (const excluded of ['node_modules', 'dist', '.harness-cache', '.git']) {
      await mkdir(join(dir, excluded), { recursive: true })
      await writeFile(join(dir, excluded, 'junk.txt'), 'junk')
    }
    await writeFile(join(dir, 'src', 'index.js.map'), '{}')
    await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{}')
    const after = await computePluginDirDigest(dir)
    expect(after.files).toEqual(before.files)
    expect(after.digest).toBe(before.digest)
  })

  it('排除构建产物后：签名后重新构建（tsbuildinfo / sourcemap 变化）仍校验通过', async () => {
    const dir = await makePluginDir('rebuild-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{"build":1}')
    await signPluginDir(dir, pair.privateKeyPem)

    await writeFile(join(dir, 'tsconfig.tsbuildinfo'), '{"build":2,"program":{}}')
    await writeFile(join(dir, 'src', 'index.js.map'), '{"version":3}')
    const decision = await verifyPluginDir(dir, parseKeyring(pair.publicKey))
    expect(decision.status).toBe('verified')
  })
})

describe('插件签名：校验（真边界，不通过即拒绝加载）', () => {
  it('密钥对 → 签名 → 校验通过', async () => {
    const dir = await makePluginDir('good-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    const record = await signPluginDir(dir, pair.privateKeyPem)

    const decision = await verifyPluginDir(dir, parseKeyring(pair.publicKey))
    expect(decision.status).toBe('verified')
    expect(decision.keyId).toBe(record.keyId)
    expect(decision.pluginDir).toBe(dir)
  })

  it('篡改目录里任一文件 → 校验失败（内容与签名不符）', async () => {
    const dir = await makePluginDir('tampered-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    await signPluginDir(dir, pair.privateKeyPem)

    await writeFile(join(dir, 'src', 'index.ts'), "export const name = 'tampered-plugin'\nexport function apply() { /* 注入的恶意代码 */ }\n")
    const decision = await verifyPluginDir(dir, parseKeyring(pair.publicKey))
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('篡改')
  })

  it('新增一个文件也算内容变更 → 校验失败', async () => {
    const dir = await makePluginDir('added-file-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    await signPluginDir(dir, pair.privateKeyPem)

    await writeFile(join(dir, 'src', 'extra.ts'), 'export const injected = true\n')
    const decision = await verifyPluginDir(dir, parseKeyring(pair.publicKey))
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('不符')
  })

  it('用另一把密钥签名 → 拒绝（公钥不在信任清单）', async () => {
    const dir = await makePluginDir('other-key-plugin')
    dirs.push(dir)
    const trusted = generatePluginKeyPair()
    const attacker = generatePluginKeyPair()
    await signPluginDir(dir, attacker.privateKeyPem)

    const decision = await verifyPluginDir(dir, parseKeyring(trusted.publicKey))
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('不在信任清单')
  })

  it('签名文件被换成另一把密钥的签名 → 拒绝', async () => {
    const dir = await makePluginDir('swapped-sig-plugin')
    dirs.push(dir)
    const trusted = generatePluginKeyPair()
    const attacker = generatePluginKeyPair()
    await signPluginDir(dir, trusted.privateKeyPem)

    const sig = JSON.parse(await readFile(join(dir, PLUGIN_SIGNATURE_FILE), 'utf-8')) as Record<string, unknown>
    sig.keyId = fingerprintPublicKey(attacker.publicKey)
    sig.signature = Buffer.from('not-a-real-signature').toString('base64')
    await writeFile(join(dir, PLUGIN_SIGNATURE_FILE), JSON.stringify(sig))

    const decision = await verifyPluginDir(dir, parseKeyring(trusted.publicKey))
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('不在信任清单')
  })

  it('未签名目录 → 拒绝（拒绝原因可读）', async () => {
    const dir = await makePluginDir('unsigned-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    const decision = await verifyPluginDir(dir, parseKeyring(pair.publicKey))
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('未签名')
  })
})

describe('插件签名：信任清单与「未配置」时的行为', () => {
  it('keyring 条目支持 <别名>:<公钥>，指纹按公钥计算', () => {
    const pair = generatePluginKeyPair()
    const keys = parseKeyring(`local-dev:${pair.publicKey}`)
    expect(keys).toHaveLength(1)
    expect(keys[0].name).toBe('local-dev')
    expect(keys[0].id).toBe(pair.keyId)

    const both = parseKeyring(`a:${pair.publicKey}, b:${generatePluginKeyPair().publicKey}`)
    expect(both).toHaveLength(2)
  })

  it('keyring 条目无法解析为公钥时抛错（fail-closed，不静默放宽信任）', () => {
    expect(() => parseKeyring('not-a-key')).toThrow(/keyring 条目无法解析/)
  })

  it('环境变量 HARNESS_PLUGIN_KEYRING 优先提供信任清单', () => {
    const pair = generatePluginKeyPair()
    expect(keyringFromEnv({ HARNESS_PLUGIN_KEYRING: pair.publicKey })[0].id).toBe(pair.keyId)
    expect(keyringFromEnv({})).toEqual([])
  })

  it('未配置信任清单：允许加载，但有「未校验」提示（且每进程只提示一次）', async () => {
    const dir = await makePluginDir('unverified-plugin')
    dirs.push(dir)
    const entry = join(dir, 'src', 'index.ts')
    const notices: string[] = []

    const first = await verifyPluginEntryFile(entry, { keyring: [], onNotice: (n) => notices.push(n) })
    expect(first.status).toBe('unverified')
    expect(first.notice).toContain('未校验')
    expect(first.pluginDir).toBe(dir)

    const second = await verifyPluginEntryFile(entry, { keyring: [], onNotice: (n) => notices.push(n) })
    expect(second.status).toBe('unverified')
    expect(notices).toHaveLength(1) // 一次性提示，不刷屏
  })

  it('配置了信任清单：未签名插件 loadPluginModule 之前即被判定 rejected', async () => {
    const dir = await makePluginDir('strict-unsigned-plugin')
    dirs.push(dir)
    const pair = generatePluginKeyPair()
    const decision = await verifyPluginEntryFile(join(dir, 'src', 'index.ts'), {
      keyring: parseKeyring(pair.publicKey),
    })
    expect(decision.status).toBe('rejected')
    expect(decision.reason).toContain('未签名')
  })
})
