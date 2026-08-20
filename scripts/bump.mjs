/**
 * 版本管理：统一 bump 根包与所有 packages/*、examples/* 的版本。
 * 用法：
 *   node scripts/bump.mjs                # 显示当前版本
 *   node scripts/bump.mjs 0.1.1 --dry-run   # 预览改动
 *   node scripts/bump.mjs 0.1.1          # 执行
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run')
const newVersion = process.argv[2]

function semverOk(v) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)
}

function exists(p) {
  try {
    readFileSync(p, 'utf-8')
    return true
  } catch {
    return false
  }
}

function collectPackageFiles() {
  const files = [join(ROOT, 'package.json')]
  for (const dir of ['packages', 'examples']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      const p = join(ROOT, dir, name, 'package.json')
      if (exists(p)) files.push(p)
    }
  }
  return files
}

const files = collectPackageFiles()

if (!newVersion) {
  console.log(`当前版本：${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version}`)
  console.log(`用法：node scripts/bump.mjs <semver> [--dry-run]`)
  process.exit(0)
}
if (!semverOk(newVersion)) {
  console.error(`✗ 非法版本号："${newVersion}"（需形如 0.1.1 / 1.2.3-rc.1）`)
  process.exit(2)
}

const changed = []
for (const p of files) {
  const pkg = JSON.parse(readFileSync(p, 'utf-8'))
  if (pkg.version && pkg.version !== newVersion) {
    changed.push({ p, from: pkg.version })
    if (!dryRun) {
      pkg.version = newVersion
      writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
    }
  }
}

if (dryRun) {
  console.log(`（dry-run）将把 ${changed.length} 个文件统一为 ${newVersion}：`)
  for (const c of changed) console.log(`  ${c.p}（${c.from} → ${newVersion}）`)
  console.log('\n提示：bump 后运行 pnpm check，再 node scripts/publish.mjs --no-dry-run 发布。')
} else {
  console.log(`✓ 已统一 ${changed.length} 个文件版本为 ${newVersion}`)
  console.log('  下一步：pnpm check && node scripts/publish.mjs --no-dry-run')
}
