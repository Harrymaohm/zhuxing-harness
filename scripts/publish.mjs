/**
 * 发布脚本：按依赖拓扑顺序发布所有 @zhuxing/* 包。
 * 用法：
 *   node scripts/publish.mjs             # dry-run（默认，仅打包验证）
 *   node scripts/publish.mjs --no-dry-run  # 正式发布（需已 npm login）
 *
 * 发布前自动为每个包注入 publishConfig.access = public（scoped 包默认 restricted）。
 * workspace:^ 依赖由 pnpm publish 自动转换为实际版本号。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
/** 依赖拓扑顺序：被依赖者先发布。 */
const ORDER = ['kernel', 'session', 'sandbox', 'llm', 'tools', 'config', 'agent', 'memory', 'model-router', 'skills', 'bundle', 'sdk', 'web', 'cli', 'harness']
const dryRun = !process.argv.includes('--no-dry-run')
const skipCheck = process.argv.includes('--skip-check')

if (!dryRun) {
  console.log('⚠ 即将正式发布到 npm registry。确认已 `npm login`。')
}

// 0. 发布前质量门禁（正式发布默认强制；dry-run 可跳过以提速）
if (!skipCheck) {
  console.log('\n=== 发布前门禁：pnpm check ===')
  execSync('pnpm check', { cwd: ROOT, stdio: 'inherit' })
}

// 1. 注入 publishConfig.access = public
for (const dir of ORDER) {
  const p = join(ROOT, 'packages', dir, 'package.json')
  const pkg = JSON.parse(readFileSync(p, 'utf-8'))
  pkg.publishConfig = { access: 'public', ...(pkg.publishConfig ?? {}) }
  writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
  console.log(`✓ publishConfig 就绪：${pkg.name}`)
}

// 2. 拓扑顺序发布
for (const dir of ORDER) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf-8'))
  console.log(`\n=== publish ${pkg.name}@${pkg.version} ${dryRun ? '(dry-run)' : ''} ===`)
  execSync(`pnpm publish ${dryRun ? '--dry-run' : ''} --no-git-checks`, {
    cwd: join(ROOT, 'packages', dir),
    stdio: 'inherit',
    env: { ...process.env, npm_config_yes: 'true' },
  })
}

console.log(dryRun ? '\n✓ 全部包 dry-run 通过，可正式发布。' : '\n✓ 已全部发布。')
