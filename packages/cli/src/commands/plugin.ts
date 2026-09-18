import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolvePlugins, loadPluginModule } from '@zhuxing/harness-config'
import {
  normalizePlugin,
  HarnessError,
  findPluginRoot,
  generatePluginKeyPair,
  resolvePluginKeyring,
  signPluginDir,
  verifyPluginDir,
} from '@zhuxing/harness-kernel'
import { fmt, out, outError } from '../output.js'

export async function cmdValidate(args: string[]): Promise<void> {
  const filePath = args[0]
  if (!filePath) {
    outError('用法：harness validate <插件路径>')
    process.exitCode = 2
    return
  }
  try {
    const mod = await loadPluginModule(filePath)
    const def = normalizePlugin(mod)
    out(`${fmt.green('✓')} 插件 "${def.name}" 校验通过`)
    if (def.version) out(`  版本：${def.version}`)
    if (def.description) out(`  描述：${def.description}`)
    out(`  inject：${def.inject?.length ? def.inject.join(', ') : '（无）'}`)
    out(`  provides：${def.provides?.length ? def.provides.join(', ') : '（无）'}`)
    // 开发期建议
    if (!def.description) out(`  ${fmt.yellow('建议：')}补充 description 描述插件用途`)
    if (def.inject && def.inject.length === 0 && !def.provides) {
      out(`  ${fmt.yellow('建议：')}插件既无依赖也无提供服务，仅用于副作用（事件/工具）时请确认`)
    }
  } catch (err) {
    const he = HarnessError.from(err)
    outError(`${fmt.red('✗')} 校验失败：${he.message}`)
    if (he.hint) outError(`  提示：${he.hint}`)
    process.exitCode = 2
  }
}

export async function cmdCreatePlugin(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    outError('用法：harness create-plugin <名称>')
    process.exitCode = 2
    return
  }
  const dir = resolve(args[1] ?? join('plugins', name))
  await mkdir(join(dir, 'src'), { recursive: true })

  const indexContent = `import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = '${name}'
export const version = '0.1.0'
export const description = ''

// 声明依赖的服务（就绪后 apply 才会执行）
export const inject = ['tools']

export function apply(ctx: Context) {
  const tools = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools')

  // 能力一：注册工具（模型可调用）；注销函数绑定 ctx.effect，卸载/热重载自动清理
  const unregisterTool = tools.register(
    defineTool({
      name: '${name}_hello',
      description: '示例工具：问候',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      execute: async (args) => ({ text: \`你好，\${String(args.name)}！\` }),
    }),
  )

  // 能力二：订阅事件（可拦截/记录 agent 执行）
  ctx.on('agent/pre-step', (payload) => {
    ctx.logger.debug('[${name}] pre-step', payload)
  })

  // 能力三：可逆副作用（插件卸载时自动清理）
  ctx.effect(() => {
    unregisterTool()
    ctx.logger.info('[${name}] unloaded')
  })

  ctx.logger.info('[${name}] loaded')
}
`
  await writeFile(join(dir, 'src', 'index.ts'), indexContent, 'utf-8')

  const pkgContent = `{
  "name": "${name}",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@zhuxing/harness-sdk": "workspace:^0.1.0",
    "typescript": "^5.7.0"
  }
}
`
  await writeFile(join(dir, 'package.json'), pkgContent, 'utf-8')

  const tsconfigContent = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`
  await writeFile(join(dir, 'tsconfig.json'), tsconfigContent, 'utf-8')

  out(`${fmt.green('✓')} 插件脚手架已生成：${dir}`)
  out('  下一步：')
  out(`  1. 实现能力后校验：harness validate ${join(dir, 'src', 'index.ts')}`)
  out('  2. 通过 patch 接入：在配置中写入 path 指向 src/index.ts')
}

/**
 * 安装本地插件。
 *
 * 供应链治理：配置了信任公钥（keyring）时，**先校验再复制**，不通过即拒绝安装（fail-closed）；
 * 没配置信任公钥时保持既有行为，只提示一次「签名未校验」（不校验 ≠ 通过）。
 */
export async function cmdInstall(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { as: { type: 'string' } },
    allowPositionals: true,
  })
  const source = positionals[0]
  if (!source) {
    outError('用法：harness install <插件源目录> [--as <名称>]')
    process.exitCode = 2
    return
  }
  const srcDir = resolve(source)
  const trusted = resolvePluginKeyring()
  if (trusted.length > 0) {
    const decision = await verifyPluginDir(srcDir, trusted)
    if (decision.status === 'rejected') {
      outError(`${fmt.red('✗')} 拒绝安装 ${srcDir}：签名校验未通过——${decision.reason}`)
      process.exitCode = 2
      return
    }
    out(`${fmt.green('✓')} 签名校验通过（${decision.keyId}）`)
  } else {
    out(fmt.yellow('提示：插件签名未校验（未配置信任公钥 HARNESS_PLUGIN_KEYRING 或 plugins.trustedKeys）'))
  }
  const name = values.as ?? basename(srcDir)
  const target = resolve('plugins', name)
  await cp(srcDir, target, {
    recursive: true,
    filter: (src) => {
      const base = basename(src)
      return base !== 'node_modules' && base !== '.git' && base !== 'dist' && base !== '.harness-cache'
    },
  })
  out(`${fmt.green('✓')} 已安装插件到 ${target}`)
  out('\n接入 harness（写入 patch 文件）：')
  out(`  plugins:\n    - id: ${name}\n      path: ${join(target, 'src', 'index.ts')}`)
}

/** 把「插件目录」或「插件入口文件」统一解析为插件目录。 */
async function resolvePluginDir(target: string): Promise<string> {
  const abs = resolve(target)
  const info = await stat(abs).catch(() => undefined)
  if (info?.isDirectory()) return abs
  return findPluginRoot(abs) ?? dirname(abs)
}

/**
 * 生成 ed25519 签名密钥对。私钥写入文件（0600），**绝不打屏、绝不入库**。
 */
export async function cmdPluginKeygen(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, name: { type: 'string' } },
  })
  const outPath = resolve(values.out ?? join(homedir(), '.zhuxing-harness', 'plugin-signing-key.pem'))
  const pair = generatePluginKeyPair()
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, pair.privateKeyPem, { encoding: 'utf-8', mode: 0o600 })
  out(`${fmt.green('✓')} 已生成 ed25519 密钥对`)
  out(`  私钥（PKCS#8 PEM，权限 0600；切勿提交或外泄）：${outPath}`)
  out(`  公钥指纹：${pair.keyId}`)
  out(`  信任清单条目（写入环境变量 HARNESS_PLUGIN_KEYRING 或配置 plugins.trustedKeys）：`)
  out(`    ${values.name ?? 'my-plugin-key'}:${pair.publicKey}`)
}

/**
 * 对插件目录签名：覆盖「目录下全部参与文件」的摘要（见 kernel 的 computePluginDirDigest），
 * 写入插件目录下的 .harness-signature.json。
 */
export async function cmdPluginSign(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string', short: 'k' } },
    allowPositionals: true,
  })
  const target = positionals[0]
  const keyPath = values.key ?? process.env.HARNESS_PLUGIN_SIGNING_KEY
  if (!target || !keyPath) {
    outError('用法：harness plugin-sign <插件目录|入口文件> --key <私钥 PEM 文件>')
    outError('  私钥可用 harness plugin-keygen 生成；也可用环境变量 HARNESS_PLUGIN_SIGNING_KEY 指定。')
    process.exitCode = 2
    return
  }
  try {
    const dir = await resolvePluginDir(target)
    const privateKeyPem = await readFile(resolve(keyPath), 'utf-8')
    const record = await signPluginDir(dir, privateKeyPem)
    out(`${fmt.green('✓')} 已签名：${dir}`)
    out(`  签名公钥指纹：${record.keyId}`)
    out(`  目录摘要：${record.digest}（参与文件 ${record.files} 个）`)
    out(`  签名文件：${join(dir, '.harness-signature.json')}`)
  } catch (err) {
    outError(`${fmt.red('✗')} 签名失败：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}

/**
 * 独立校验：按信任清单校验插件目录/入口文件的签名。
 * 未配置信任公钥时如实说明「无法校验」（不校验 ≠ 通过），并给出非零退出码。
 */
export async function cmdPluginVerify(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const target = positionals[0] ?? '.'
  const trusted = resolvePluginKeyring()
  if (trusted.length === 0) {
    outError(`${fmt.yellow('!')} 未配置信任公钥，无法校验签名（不校验不等于通过）`)
    outError('  用 harness plugin-keygen 生成密钥对，再把公钥写入 HARNESS_PLUGIN_KEYRING 或配置 plugins.trustedKeys。')
    process.exitCode = 2
    return
  }
  try {
    const dir = await resolvePluginDir(target)
    const decision = await verifyPluginDir(dir, trusted)
    if (decision.status === 'verified') {
      out(`${fmt.green('✓')} 签名校验通过：${dir}`)
      out(`  签名公钥指纹：${decision.keyId}`)
      return
    }
    outError(`${fmt.red('✗')} 签名校验未通过：${dir}`)
    outError(`  原因：${decision.reason}`)
    process.exitCode = 2
  } catch (err) {
    outError(`${fmt.red('✗')} 校验失败：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}

export async function cmdList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      patch: { type: 'string', short: 'p', multiple: true },
      profile: { type: 'string' },
    },
  })
  const { plugins, sources } = await resolvePlugins({
    profile: values.profile,
    patches: values.patch,
    cwd: process.cwd(),
  })
  out(`配置来源：${sources.length > 0 ? sources.join(' → ') : '（无，仅默认）'}\n`)
  if (plugins.length === 0) {
    out('（未解析到任何插件）')
    return
  }
  for (const p of plugins) {
    const state = p.enabled === false ? 'disabled' : 'enabled'
    const source = p.path ? p.path : '(inline)'
    out(`[${state}] ${p.id}\t${source}`)
  }
}
