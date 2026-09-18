/**
 * 单文件 CLI 打包 + 内核模块打包。
 * 1) harness.cjs：esbuild 将 packages/cli/src/cli.ts 打包为自包含 CJS（前置 shebang）。
 *    使用 CJS 格式以兼容 yaml 等依赖的动态 require。Web 外壳（含 RuntimeManager）打包在此，常驻不重启。
 * 2) kernel.mjs：esbuild 将 packages/runtime/src/index.ts 打包为自包含 ESM（createKernel 工厂）。
 *    这是「内核」——Web 外壳通过动态 import（带版本号破坏缓存）加载它，更新后无重启即生效。
 * 运行：pnpm bundle
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const outdir = join(repoRoot, 'dist-bin')
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
const version = rootPkg.version ?? '0.0.0'

mkdirSync(outdir, { recursive: true })

// ===== 1) 单文件 CLI（外壳：命令调度 + Web 服务器常驻进程）=====
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'cli.ts')
const cliOutfile = join(outdir, 'harness.cjs')
await build({
  entryPoints: [cliEntry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: cliOutfile,
  // 注入版本号（CJS 产物无法可靠读取 package.json）
  define: { 'globalThis.__HARNESS_VERSION__': JSON.stringify(version) },
  // esbuild 为构建期依赖，运行时从 node_modules 解析；其余 workspace 包与 yaml 全部打包进单文件
  external: ['esbuild'],
  logLevel: 'info',
})

// CJS 的 shebang 必须位于文件第一行：打包后手动前置
const content = readFileSync(cliOutfile, 'utf-8')
writeFileSync(cliOutfile, content.startsWith('#!') ? content : `#!/usr/bin/env node\n${content}`, 'utf-8')
console.log(`✓ 已打包单文件 CLI → ${cliOutfile}`)
console.log(`  验证：node ${cliOutfile} version`)

// ===== 2) 内核模块（可热更新单元）=====
const kernelEntry = join(repoRoot, 'packages', 'runtime', 'src', 'index.ts')
const kernelOutfile = join(outdir, 'kernel.mjs')
await build({
  entryPoints: [kernelEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: kernelOutfile,
  // 内核自包含：把 agent/bundle/kernel/tools/memory/session/skills 等全部打包进单个 ESM 文件，
  // 外壳动态 import 时不依赖外部 node_modules，更新只需替换这一个文件。
  external: [],
  // 第三方依赖（如 ws）可能在运行时调用 require('events') 等 node 内置模块。
  // ESM 产物中 esbuild 的 __require 兜底若检测到存在顶层 require 便委托给它，
  // 因此在 banner 注入真实 require（createRequire），让内置模块可靠解析。
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
})
console.log(`✓ 已打包内核模块 → ${kernelOutfile}`)
console.log(`  验证：node --input-type=module -e "const m = await import('${kernelOutfile.replace(/\\/g, '/')}'); console.log(typeof m.createKernel, typeof m.kernelSelfTest)"`)
