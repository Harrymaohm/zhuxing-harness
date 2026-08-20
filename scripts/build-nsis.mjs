/**
 * 构建 NSIS 安装包：组装 dist-install/app 后在无中文路径的临时目录打包（规避 NSIS 中文路径问题）。
 * 用法：
 *   node scripts/build-nsis.mjs            # build-dist + 打包（默认）
 *   node scripts/build-nsis.mjs --dist-only # 仅组装 app 目录
 */
import { execSync } from 'node:child_process'
import { chdir } from 'node:process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const makensis = join(ROOT, 'tools', 'nsis', 'nsis-3.10', 'makensis.exe')
const onlyDist = process.argv.includes('--dist-only')

/** 递归复制（规避 cpSync 中文路径崩溃）。 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

// 1. 组装 app 目录
execSync('node scripts/build-dist.mjs', { cwd: ROOT, stdio: 'inherit' })
if (onlyDist) {
  console.log('（--dist-only：仅组装 app 目录，跳过 NSIS 打包）')
  process.exit(0)
}

// 2. 读取版本
const version = readFileSync(join(ROOT, 'dist-install', 'app', 'VERSION'), 'utf-8').trim()

// 3. 在无中文路径的临时目录打包（NSIS 对中文路径支持不佳）
const tmp = mkdtempSync(join(tmpdir(), 'zhuxing-nsis-'))
copyDir(join(ROOT, 'dist-install', 'app'), join(tmp, 'app'))
const nsiSrc = readFileSync(join(ROOT, 'scripts', 'nsis', 'installer.nsi'), 'utf-8')
writeFileSync(join(tmp, 'installer.nsi'), `\uFEFF${nsiSrc}`, 'utf-8') // UTF-8 BOM，支持中文

try {
  chdir(tmp)
  console.log(`\n=== makensis 打包 v${version}（临时目录 ${tmp}）===`)
  execSync(`"${makensis}" -DAPP_VERSION=${version} installer.nsi`, { stdio: 'inherit' })

  const exe = join(tmp, `zhuxing-harness-setup-${version}.exe`)
  const target = join(ROOT, 'dist-install', basename(exe))
  copyFileSync(exe, target)
  console.log(`\n✓ 安装包已生成：${target}`)
} finally {
  chdir(ROOT)
  rmSync(tmp, { recursive: true, force: true })
}
