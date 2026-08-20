/**
 * 单文件 CLI 打包：esbuild 将 packages/cli/src/cli.ts 打包为自包含 CJS，
 * 输出到 dist-bin/harness.cjs（前置 shebang，可 `node dist-bin/harness.cjs` 或发布为 bin）。
 * 使用 CJS 格式以兼容 yaml 等依赖的动态 require。
 * 运行：pnpm bundle
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = join(repoRoot, 'packages', 'cli', 'src', 'cli.ts')
const outdir = join(repoRoot, 'dist-bin')
const outfile = join(outdir, 'harness.cjs')
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))

mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  // 注入版本号（CJS 产物无法可靠读取 package.json）
  define: { 'globalThis.__HARNESS_VERSION__': JSON.stringify(rootPkg.version ?? '0.0.0') },
  // esbuild 为构建期依赖，运行时从 node_modules 解析；其余 workspace 包与 yaml 全部打包进单文件
  external: ['esbuild'],
  logLevel: 'info',
})

// CJS 的 shebang 必须位于文件第一行：打包后手动前置
const content = readFileSync(outfile, 'utf-8')
if (!content.startsWith('#!')) {
  writeFileSync(outfile, `#!/usr/bin/env node\n${content}`, 'utf-8')
}

console.log(`✓ 已打包单文件 CLI → ${outfile}`)
console.log(`  验证：node ${outfile} version`)
