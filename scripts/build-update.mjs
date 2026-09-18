/**
 * 生成应用内增量更新包 + manifest.json。
 * 从 dist-install/app 提取「会变化的文件」打包为 zip，计算 sha256，生成更新清单。
 * 默认生成「完整更新包」（含外壳 harness.cjs，冷更新回退路径）；
 * 设置 HARNESS_UPDATE_KERNEL_ONLY=1 时生成「内核热更新包」（仅 bin/kernel.mjs + VERSION + 变更说明，不停服）。
 * 同时基于 git 变更自动生成《本次内核变更说明》自检报告（证据链）。
 * 前置：pnpm build && pnpm bundle && pnpm --filter @zhuxing/harness-web build:ui && node scripts/build-dist.mjs
 * 运行：node scripts/build-update.mjs
 * 输出：dist-update/harness-update-<版本>.zip + manifest.json
 */
import AdmZip from 'adm-zip'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP = join(ROOT, 'dist-install', 'app')
const OUT = join(ROOT, 'dist-update')

const KERNEL_ONLY = process.env.HARNESS_UPDATE_KERNEL_ONLY === '1'

/** 内核热更新包包含的相对路径（不停服，外壳下次指令自动加载新内核）。 */
const KERNEL_INCLUDE = ['bin/kernel.mjs', 'VERSION', 'kernel-changelog.md']

/** 完整更新包包含的相对路径（含外壳；会触发一次冷更新重启）。 */
const FULL_INCLUDE = [
  'bin/harness.cjs',
  'bin/kernel.mjs',
  'bin/web-launcher.mjs',
  'bin/launch.vbs',
  'web/dist-ui',
  'harness.cmd',
  'harness-web.cmd',
  'harness.ico',
  'VERSION',
  'kernel-changelog.md',
]

function git(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** 定位 diff 基线：最近一次 release tag，否则上一提交。 */
function detectPrevRef() {
  const described = git('git describe --tags --abbrev=0')
  if (described) return described
  return 'HEAD~1'
}

/** 从 diff 中提取变更文件的函数名（只对源码文件生效，作为「改了哪几个函数」的依据）。 */
function collectChangedFunctions(prevRef) {
  const files = git(`git diff --name-only ${prevRef} --`).split('\n').filter(Boolean)
  const result = new Map() // file -> string[]（函数名）
  const FUNC_DEF = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/

  for (const file of files) {
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue
    let lines
    try {
      lines = readFileSync(join(ROOT, file), 'utf-8').split('\n')
    } catch {
      continue
    }
    const diff = git(`git diff -U0 ${prevRef} -- ${file}`)
    const hunks = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)]
    const found = new Set()
    for (const hunk of hunks) {
      const newLine = Number(hunk[1])
      for (let i = Math.min(newLine - 1, lines.length - 1); i >= 0; i--) {
        const m = FUNC_DEF.exec(lines[i])
        if (m) {
          const name = m[1] || m[2]
          if (name) found.add(name)
          break
        }
      }
    }
    // 新增文件特例：diff hunk 从第 1 行开始，向上回溯找不到归属函数 →
    // 改为整文件扫描顶层函数定义（否则新文件的函数名会整体丢失，表现为「涉及文件」有、函数级没有）。
    const status = git(`git diff --name-status ${prevRef} -- ${file}`).split('\t')[0]
    if (status === 'A') {
      for (const line of lines) {
        const m = FUNC_DEF.exec(line)
        if (m) {
          const name = m[1] || m[2]
          if (name) found.add(name)
        }
      }
    }

    if (found.size) result.set(file, [...found])
  }
  return result
}

/** 生成《本次内核变更说明》。 */
function generateKernelChangelog(prevRef, version, toVersion) {
  const changedFiles = git(`git diff --name-only ${prevRef} -- packages scripts`).split('\n').filter(Boolean)
  const funcMap = collectChangedFunctions(prevRef)
  const fixCommits = git(`git log --oneline ${prevRef}..HEAD`)
    .split('\n')
    .filter((l) => /fix|bug|修复|修復|纠错|缺陷|issue/i.test(l))
    .map((l) => `- ${l}`)
  const funcCount = [...funcMap.values()].reduce((n, arr) => n + arr.length, 0)

  const lines = []
  lines.push(`# 《本次内核变更说明》`)
  lines.push('')
  lines.push(`- 版本：${version} → ${toVersion}`)
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`- 变更基线：${prevRef}`)
  lines.push(`- 内核模块：bin/kernel.mjs`)
  lines.push(`- 变更函数：${funcCount} 处`)
  lines.push('')
  lines.push('## 一、涉及文件')
  lines.push('')
  if (changedFiles.length) {
    for (const f of changedFiles) lines.push(`- ${f}`)
  } else {
    lines.push('- （无，本次为纯内核模块重打包）')
  }
  lines.push('')
  lines.push('## 二、变更函数（函数级）')
  lines.push('')
  if (funcMap.size) {
    for (const [file, fns] of funcMap) {
      lines.push(`- ${file}`)
      for (const fn of fns) lines.push(`  - ${fn}()`)
    }
  } else {
    lines.push('- （未自动检测到顶层函数变更，请以源码为准）')
  }
  lines.push('')
  lines.push('## 三、潜在 Bug 修复')
  lines.push('')
  if (fixCommits.length) {
    lines.push(...fixCommits)
  } else {
    lines.push('- （本次未检出显式修复类提交）')
  }
  lines.push('')
  lines.push('---')
  lines.push('> 本报告由发布脚本基于 git 变更自动生成，用于留存内核更新的证据链，供用户侧核对。')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
  const zipName = `harness-update-${version}.zip`
  const prevRef = detectPrevRef()

  // 校验来源目录
  if (!existsSync(join(APP, 'bin', 'harness.cjs'))) {
    console.error('✗ 缺少 dist-install/app/bin/harness.cjs。请先运行 build-dist。')
    process.exit(1)
  }
  if (!existsSync(join(APP, 'bin', 'kernel.mjs'))) {
    console.error('✗ 缺少 dist-install/app/bin/kernel.mjs。请先运行 build-dist。')
    process.exit(1)
  }

  // 生成《本次内核变更说明》自检报告，写入 APP 供打包 & 留档
  const changelog = generateKernelChangelog(prevRef, version, version)
  writeFileSync(join(APP, 'kernel-changelog.md'), changelog, 'utf-8')
  process.stdout.write(`\n——— 《本次内核变更说明》 ———\n${changelog}\n─────────────────────────\n\n`)

  mkdirSync(OUT, { recursive: true })

  const include = KERNEL_ONLY ? KERNEL_INCLUDE : FULL_INCLUDE
  const zip = new AdmZip()
  for (const rel of include) {
    const src = join(APP, rel)
    if (!existsSync(src)) {
      console.error(`✗ 缺少增量文件：${rel}`)
      process.exit(1)
    }
    const isDir = statSync(src).isDirectory()
    if (isDir) zip.addLocalFolder(src, rel)
    else zip.addLocalFile(src, rel.split('/').slice(0, -1).join('/') || '.')
  }

  const zipPath = join(OUT, zipName)
  zip.writeZip(zipPath)

  const data = readFileSync(zipPath)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const size = data.length

  const manifest = {
    latestVersion: version,
    channel: 'stable',
    publishedAt: new Date().toISOString(),
    updateFile: zipName,
    sha256,
    size,
    releaseNotes: process.env.HARNESS_UPDATE_NOTES ?? '',
    minVersion: process.env.HARNESS_UPDATE_MIN_VERSION ?? version,
  }
  // 安装包轨（分轨约定）：zip 增量只承载代码与 UI；Electron 运行时变更只能通过新安装包分发。
  // 发布桌面端新版本时用 HARNESS_INSTALLER_VERSION / HARNESS_INSTALLER_URL 声明，客户端据此提示重装。
  if (process.env.HARNESS_INSTALLER_VERSION) {
    manifest.installer = {
      version: process.env.HARNESS_INSTALLER_VERSION,
      url: process.env.HARNESS_INSTALLER_URL ?? '',
      notes: process.env.HARNESS_INSTALLER_NOTES ?? '',
    }
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  console.log(`✓ 增量包：${zipPath}`)
  console.log(`✓ 类型：${KERNEL_ONLY ? '内核热更新' : '完整更新'}${KERNEL_ONLY ? '（不停服，外壳下次指令自动加载新内核）' : ''}`)
  console.log(`✓ 大小：${size} 字节`)
  console.log(`✓ sha256：${sha256}`)
  console.log(`✓ manifest：${join(OUT, 'manifest.json')}`)
  console.log('\n部署到更新源时，把 dist-update/ 整个目录作为静态站点根即可。')
  console.log('\n提示：仅内核逻辑变更时用 `HARNESS_UPDATE_KERNEL_ONLY=1 node scripts/build-update.mjs` 生成热更新包。')
}

main()
