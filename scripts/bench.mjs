/**
 * 启动性能基准：插件转译内容哈希缓存（冷启动 vs 热启动）。
 * 运行：node scripts/bench.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginModule } from '../packages/config/dist/index.js'

const dir = mkdtempSync(join(tmpdir(), 'zhuxing-bench-'))
const src = join(dir, 'bench-plugin.ts')
writeFileSync(src, `export const name = 'bench-plugin'\nexport function apply() {}\n`)

// 冷启动：首次转译（每次改内容模拟新代码）
const coldSamples = []
for (let i = 0; i < 5; i++) {
  writeFileSync(src, `export const name = 'bench-plugin'\nexport function apply() { console.log(${i}) }\n`)
  const t0 = performance.now()
  await loadPluginModule(src)
  coldSamples.push(performance.now() - t0)
}
const coldMin = Math.min(...coldSamples)
const coldAvg = coldSamples.reduce((a, b) => a + b, 0) / coldSamples.length

// 热启动：内容不变，缓存命中（跳过 esbuild）
const hotSamples = []
for (let i = 0; i < 5; i++) {
  const t0 = performance.now()
  await loadPluginModule(src)
  hotSamples.push(performance.now() - t0)
}
const hotMin = Math.min(...hotSamples)
const hotAvg = hotSamples.reduce((a, b) => a + b, 0) / hotSamples.length

console.log('\n===== 插件转译启动性能 =====')
console.log(`  冷启动（首次转译）: min=${coldMin.toFixed(1)}ms avg=${coldAvg.toFixed(1)}ms`)
console.log(`  热启动（缓存命中）: min=${hotMin.toFixed(1)}ms avg=${hotAvg.toFixed(1)}ms`)
console.log(`  加速比: ${(coldAvg / hotAvg).toFixed(1)}x（按平均）`)

// CLI 进程级冒烟（含 Node 启动 + 插件转译）
const { execFileSync } = await import('node:child_process')
const cliPath = join(process.cwd(), 'packages', 'cli', 'dist', 'cli.js')
const pluginPath = join(process.cwd(), 'examples', 'hello-plugin', 'src', 'index.ts')

function runCli() {
  const t0 = performance.now()
  execFileSync(process.execPath, [cliPath, 'validate', pluginPath], { stdio: 'pipe' })
  return performance.now() - t0
}
// 冷：清空产物后首次（含转译）；热：缓存命中
const cacheDir = join(process.cwd(), 'examples', 'hello-plugin', '.harness-cache')
rmSync(cacheDir, { recursive: true, force: true })
const cliCold = runCli()
const cliHot = runCli()
console.log('\n===== CLI 进程级启动（validate 链路，含插件转译）=====')
console.log(`  首次运行（冷，含 esbuild 转译）: ${cliCold.toFixed(1)}ms`)
console.log(`  再次运行（热，缓存命中）: ${cliHot.toFixed(1)}ms`)
console.log(`  转译部分加速: ${(cliCold - cliHot).toFixed(1)}ms 节省`)

rmSync(dir, { recursive: true, force: true })
