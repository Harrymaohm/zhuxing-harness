/**
 * 插件签名校验（ed25519）——供应链治理里的**真安全边界**。
 *
 * 与「权限清单」的强度差异（务必分别理解、不要混为一谈）：
 * - 签名校验发生在一个插件**被加载之前**，不通过就拒绝加载（fail-closed）。它针对的是分发链路：
 *   第三方下载/安装的插件在传输或镜像侧被篡改。校验失败即不执行该插件的任何代码。
 * - 权限清单（PluginPermissions）只治理「经由 harness 边界的工具调用」，**挡不住插件直接
 *   `import('node:fs')`**（插件是进程内任意 JS），因此它是治理/审计而非隔离。
 *
 * 信任根（keyring）来源优先级：环境变量 `HARNESS_PLUGIN_KEYRING` > 配置文件 `plugins.trustedKeys`
 * （配置文件路径：`HARNESS_CONFIG` 或 `~/.zhuxing-harness/config.json`）。两者都为空时不做校验，
 * 只发一次性提示「插件签名未校验（未配置信任公钥）」。
 *
 * 密钥/清单格式：
 * - 公钥/私钥：ed25519。私钥为 PKCS#8 PEM；清单写**裸 32 字节公钥的 base64**（也接受 SPKI PEM）。
 * - keyring 字符串：条目以 `,` 或空白分隔，每条形如 `<base64 公钥>` 或 `<别名>:<base64 公钥>`。
 * - 签名文件：插件目录下的 `.harness-signature.json`，内容见 PluginSignatureFile。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** 签名文件名（位于插件目录根，**不参与**摘要计算）。 */
export const PLUGIN_SIGNATURE_FILE = '.harness-signature.json'

/** 签名文件格式标识。 */
export const PLUGIN_SIGNATURE_FORMAT = 'harness-plugin-signature/v1'

/**
 * 不参与目录摘要的路径（按路径段名匹配，任意层级生效）。
 *
 * 为什么是这几个：前四个与 `harness install` 的复制过滤规则（不复制 node_modules/.git/dist/.harness-cache）
 * 保持一致——签名必须在**安装后**的目录上仍然可校验；最后一个是签名文件自身，否则「签名改变目录内容、
 * 目录内容改变摘要」会自我循环。
 */
const DIGEST_EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', 'dist', '.harness-cache', PLUGIN_SIGNATURE_FILE])

/**
 * 不参与目录摘要的文件后缀：构建/调试产物（sourcemap、tsc 增量信息）会随构建重新生成，
 * 把它们算进摘要会让「签名后重新构建」被误判为篡改；它们也不承载可执行插件代码。
 */
const DIGEST_EXCLUDED_SUFFIXES = ['.map', '.tsbuildinfo']

/** 单个可信公钥。 */
export interface TrustedKey {
  /** 公钥指纹（sha256:<hex>），即签名文件里的 keyId。 */
  id: string
  /** 可选别名（keyring 条目里 `别名:公钥` 的前缀）。 */
  name?: string
  /** 公钥对象（不导出到签名文件）。 */
  key: KeyObject
}

/** 插件目录签名文件内容。 */
export interface PluginSignatureFile {
  format: string
  algorithm: 'ed25519'
  /** 签名公钥指纹。 */
  keyId: string
  /** 参与计算的文件集合的目录摘要（见 computePluginDirDigest）。 */
  digest: string
  /** 对 digest 字符串的 ed25519 签名（base64）。 */
  signature: string
  /** 参与摘要计算的文件数（便于人工核对，不参与验签逻辑）。 */
  files: number
  signedAt: string
}

/** 生成的密钥对（privateKeyPem 只应落盘为 0600 文件，绝不写日志或提交）。 */
export interface PluginKeyPair {
  /** 裸 32 字节 ed25519 公钥的 base64（keyring 条目就用这个）。 */
  publicKey: string
  keyId: string
  privateKeyPem: string
}

export type PluginTrustStatus = 'verified' | 'unverified' | 'rejected'

/** 一次信任判定的结果。 */
export interface PluginTrustDecision {
  status: PluginTrustStatus
  /** 被判定对象所在插件目录（能定位到时）。 */
  pluginDir?: string
  /** 校验通过的签名者 keyId。 */
  keyId?: string
  /** status=rejected 时的可读原因。 */
  reason?: string
  /** status=unverified 时的提示语（调用方应如实展示）。 */
  notice?: string
}

export interface PluginTrustOptions {
  /** 显式指定信任清单；缺省时按 env > 配置文件解析。 */
  keyring?: TrustedKey[]
  /** 未配置信任清单时的提示回调（缺省 console.warn，每进程只提示一次）。 */
  onNotice?: (notice: string) => void
}

/** ED25519 SPKI DER 前缀：裸 32 字节公钥拼接它即可被 createPublicKey 解析。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** 把公钥输入（裸 base64 / SPKI PEM）解析为 KeyObject。 */
function toPublicKey(input: string): KeyObject {
  const trimmed = input.trim()
  if (trimmed.includes('-----BEGIN')) return createPublicKey(trimmed)
  const raw = Buffer.from(trimmed, 'base64')
  if (raw.length === 32) {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  }
  return createPublicKey({ key: raw, format: 'der', type: 'spki' })
}

/** 公钥指纹（sha256:<hex>）：keyring 匹配与签名文件里的 keyId 都用它。 */
export function fingerprintPublicKey(publicKey: string | KeyObject): string {
  const key = typeof publicKey === 'string' ? toPublicKey(publicKey) : publicKey
  const raw = key.export({ type: 'spki', format: 'der' }).subarray(-32)
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`
}

/** 生成 ed25519 密钥对（不含任何文件读写）。 */
export function generatePluginKeyPair(): PluginKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const publicKeyB64 = raw.toString('base64')
  return {
    publicKey: publicKeyB64,
    keyId: fingerprintPublicKey(publicKeyB64),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/**
 * 解析 keyring 字符串：条目以 `,` 或空白分隔，每条形如 `<公钥>` 或 `<别名>:<公钥>`。
 * 解析不出的条目直接抛错（fail-closed：宁可不启动也不静默放宽信任）。
 */
export function parseKeyring(raw: string | undefined): TrustedKey[] {
  if (!raw) return []
  const keys: TrustedKey[] = []
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const sep = entry.indexOf(':')
    const name = sep > 0 ? entry.slice(0, sep) : undefined
    const value = sep > 0 ? entry.slice(sep + 1) : entry
    try {
      const key = toPublicKey(value)
      keys.push({ id: fingerprintPublicKey(key), name, key })
    } catch (err) {
      throw new Error(
        `[plugin-trust] keyring 条目无法解析为 ed25519 公钥：${name ?? ''}${name ? ':' : ''}${value.slice(0, 12)}…（${err instanceof Error ? err.message : String(err)}）`,
        { cause: err },
      )
    }
  }
  return keys
}

/** 从环境变量 HARNESS_PLUGIN_KEYRING 读取信任清单。 */
export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): TrustedKey[] {
  return parseKeyring(env.HARNESS_PLUGIN_KEYRING)
}

/** 配置文件路径（与 CLI 的 config-store 同一约定：HARNESS_CONFIG 覆盖用户级路径）。 */
export function harnessConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_CONFIG ?? join(homedir(), '.zhuxing-harness', 'config.json')
}

/** 从配置文件的 `plugins.trustedKeys` 读取信任清单（数组，元素为 keyring 条目字符串）。 */
export function keyringFromConfig(configPath = harnessConfigPath()): TrustedKey[] {
  if (!existsSync(configPath)) return []
  let parsed: unknown
  try {
    // 配置文件极小且只在启动/加载路径读一次，同步读避免把加载路径搞成异步链
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: { trustedKeys?: unknown } }).plugins
  const list = plugins?.trustedKeys
  if (!Array.isArray(list)) return []
  return parseKeyring(list.filter((v): v is string => typeof v === 'string').join(','))
}

/**
 * 解析信任清单：环境变量优先，其次配置文件。两者都为空 → 返回空数组（调用方按「不校验」处理并提示）。
 */
export function resolvePluginKeyring(env: NodeJS.ProcessEnv = process.env): TrustedKey[] {
  const fromEnv = keyringFromEnv(env)
  if (fromEnv.length > 0) return fromEnv
  return keyringFromConfig(env.HARNESS_CONFIG ?? harnessConfigPath(env))
}

/** 未配置信任清单时的提示是否已发过（每进程一次，避免刷屏）。 */
let trustNoticeEmitted = false

/** 复位「已提示」状态（仅供测试在同一进程内重复断言）。 */
export function resetPluginTrustNotice(): void {
  trustNoticeEmitted = false
}

/** 目录摘要：对目录下全部参与文件按稳定顺序计算 sha256，再对清单文本取摘要。 */
export async function computePluginDirDigest(dir: string): Promise<{ digest: string; files: string[] }> {
  const root = resolve(dir)
  const files = await collectFiles(root, root)
  files.sort()
  const lines: string[] = []
  for (const rel of files) {
    const content = await readFile(join(root, rel.split('/').join(sep)))
    lines.push(`${rel}\n${createHash('sha256').update(content).digest('hex')}`)
  }
  const digest = createHash('sha256').update(lines.join('\n'), 'utf-8').digest('hex')
  return { digest, files }
}

/** 递归收集参与摘要的文件（相对路径用 `/` 分隔，保证跨平台稳定）。 */
async function collectFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (DIGEST_EXCLUDED_SEGMENTS.has(entry.name)) continue
    if (DIGEST_EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, abs)))
      continue
    }
    out.push(relative(root, abs).split(sep).join('/'))
  }
  return out
}

/**
 * 对插件目录签名：计算目录摘要、用私钥签名、写入 `.harness-signature.json`。
 * 私钥**只**在此处作为入参使用，不落日志、不写进签名文件。
 */
export async function signPluginDir(dir: string, privateKeyPem: string): Promise<PluginSignatureFile> {
  const root = resolve(dir)
  const { digest, files } = await computePluginDirDigest(root)
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKey = createPublicKey(privateKey)
  const record: PluginSignatureFile = {
    format: PLUGIN_SIGNATURE_FORMAT,
    algorithm: 'ed25519',
    keyId: fingerprintPublicKey(publicKey),
    digest,
    signature: sign(null, Buffer.from(digest, 'utf-8'), privateKey).toString('base64'),
    files: files.length,
    signedAt: new Date().toISOString(),
  }
  await writeFile(join(root, PLUGIN_SIGNATURE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
  return record
}

/**
 * 用信任清单校验插件目录（真边界：调用方必须在**加载/安装前**判定，rejected 即拒绝）。
 * 判定顺序：有签名文件 → 公钥在清单内 → 签名有效 → 目录内容与签名一致。
 */
export async function verifyPluginDir(dir: string, trustedKeys: TrustedKey[]): Promise<PluginTrustDecision> {
  const root = resolve(dir)
  const sigPath = join(root, PLUGIN_SIGNATURE_FILE)
  if (!existsSync(sigPath)) {
    return { status: 'rejected', pluginDir: root, reason: `未找到 ${PLUGIN_SIGNATURE_FILE}（该插件未签名）` }
  }
  let record: PluginSignatureFile
  try {
    record = JSON.parse(await readFile(sigPath, 'utf-8')) as PluginSignatureFile
  } catch (err) {
    return {
      status: 'rejected',
      pluginDir: root,
      reason: `签名文件无法解析：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (record.format !== PLUGIN_SIGNATURE_FORMAT) {
    return { status: 'rejected', pluginDir: root, reason: `签名文件格式不支持：${String(record.format)}` }
  }
  if (record.algorithm !== 'ed25519') {
    return { status: 'rejected', pluginDir: root, reason: `签名算法不支持：${String(record.algorithm)}` }
  }
  const match = trustedKeys.find((k) => k.id === record.keyId)
  if (!match) {
    return {
      status: 'rejected',
      pluginDir: root,
      reason: `签名公钥 ${record.keyId} 不在信任清单（keyring）中`,
    }
  }
  const ok = verify(
    null,
    Buffer.from(record.digest, 'utf-8'),
    match.key,
    Buffer.from(record.signature, 'base64'),
  )
  if (!ok) {
    return { status: 'rejected', pluginDir: root, keyId: record.keyId, reason: '签名无效（签名与公钥不匹配，签名文件可能被篡改）' }
  }
  const { digest } = await computePluginDirDigest(root)
  if (digest !== record.digest) {
    return {
      status: 'rejected',
      pluginDir: root,
      keyId: record.keyId,
      reason: `插件内容与签名不符（目录在签名后被修改或篡改）：摘要 ${digest.slice(0, 12)}… ≠ 签名记录的 ${record.digest.slice(0, 12)}…`,
    }
  }
  return { status: 'verified', pluginDir: root, keyId: record.keyId }
}

/** 从入口文件向上定位插件目录：命中的是「含签名文件」或「含 package.json」的最近一层。 */
export function findPluginRoot(entryFile: string): string | undefined {
  let dir = dirname(resolve(entryFile))
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, PLUGIN_SIGNATURE_FILE))) return dir
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * 加载前判定：给定插件入口文件，定位插件目录并校验。
 * - 未配置 keyring：允许（保持既有行为），但给出一次性提示——不校验就等于没有供应链保证。
 * - 配置了 keyring：未签名 / 公钥不可信 / 签名无效 / 内容不符，一律 rejected。
 */
export async function verifyPluginEntryFile(
  entryFile: string,
  options: PluginTrustOptions = {},
): Promise<PluginTrustDecision> {
  const trusted = options.keyring ?? resolvePluginKeyring()
  const root = findPluginRoot(entryFile)
  if (trusted.length === 0) {
    const notice = `插件签名未校验（未配置信任公钥）：${root ?? resolve(entryFile)}（设置 HARNESS_PLUGIN_KEYRING 或配置 plugins.trustedKeys 后启用校验）`
    if (!trustNoticeEmitted) {
      trustNoticeEmitted = true
      if (options.onNotice) options.onNotice(notice)
      else console.warn(`[plugin-trust] ${notice}`)
    }
    return { status: 'unverified', pluginDir: root, notice }
  }
  if (!root) {
    return {
      status: 'rejected',
      reason: `无法从 ${resolve(entryFile)} 定位插件目录（未找到 ${PLUGIN_SIGNATURE_FILE} 或 package.json），已配置信任公钥时拒绝加载未签名插件`,
    }
  }
  return verifyPluginDir(root, trusted)
}
