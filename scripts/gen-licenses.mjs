/**
 * 生成第三方依赖与许可证声明（licenses/ 目录）。
 *
 * 为什么要有它：
 * 1. 本项目自身是「源码可用 · 非商业免费 · 商业付费授权」的双许可，因此**必须**完整声明
 *    用到的第三方组件及其许可证——这既是合规义务，也是商业授权谈判时的事实基础。
 * 2. 打包链路（esbuild / vite）会把依赖**内联**进 bin/harness.cjs、bin/kernel.mjs 与前端
 *    chunk，产物里不再有各依赖自己的 LICENSE 文件。也就是说单看产物是查不到许可证的，
 *    必须有一份随仓库维护、并随发行物分发的声明。
 * 3. 手抄的清单必然腐烂。这里每次都以 `pnpm licenses list` 的实测结果为准重新生成。
 *
 * 用法：
 *   node scripts/gen-licenses.mjs            # 生成/更新 licenses/ 下的声明
 *   node scripts/gen-licenses.mjs --check     # 只校验已提交的声明是否与当前依赖一致（CI 可用）
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'licenses')
const TEXTS = join(OUT, 'texts')
const checkOnly = process.argv.includes('--check')

/**
 * 许可义务分类：决定「要不要随分发物保留声明」。
 * 分类只影响阅读与自查，不影响清单内容本身。
 */
const PERMISSIVE_NO_NOTICE = new Set(['0BSD', 'CC0-1.0', 'MIT-0', 'WTFPL', 'Unlicense'])
const NEEDS_NOTICE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD', 'BlueOak-1.0.0', 'MIT AND Zlib'])
const REVIEW_REQUIRED = new Set(['MPL-2.0', 'CC-BY-4.0', 'CC-BY-3.0', 'Python-2.0', 'Artistic-2.0'])

/** 从 pnpm 读取实际安装的全部依赖（含传递依赖）。 */
function readLicenses() {
  const raw = execSync('pnpm licenses list --json', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(raw)
}

/** 展平成「一行一个包」的清单（同名多版本并列，避免同一个包出现多行难以核对）。 */
function flatten(byLicense) {
  const rows = []
  for (const [license, entries] of Object.entries(byLicense)) {
    for (const e of entries) {
      rows.push({
        name: e.name,
        versions: (e.versions ?? []).join(', '),
        license,
        author: e.author ?? '',
        homepage: e.homepage ?? '',
        paths: e.paths ?? [],
      })
    }
  }
  return rows
}

function groupByLicense(rows) {
  const map = new Map()
  for (const r of rows) {
    const list = map.get(r.license) ?? []
    list.push(r)
    map.set(r.license, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  // 需要关注的排前面，其余按包数降序
  return [...map.entries()].sort((a, b) => {
    const rank = (l) => (REVIEW_REQUIRED.has(l) ? 0 : NEEDS_NOTICE.has(l) ? 1 : 2)
    return rank(a[0]) - rank(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0])
  })
}

/** 义务分类标签。 */
function obligation(license) {
  if (REVIEW_REQUIRED.has(license)) return '⚠ 需评估'
  if (PERMISSIVE_NO_NOTICE.has(license)) return '免声明'
  if (NEEDS_NOTICE.has(license)) return '需保留声明'
  if (/[()]|OR|AND/.test(license)) return '表达式'
  return '需保留声明'
}

/** 找一份可读的许可证原文（各包自带的 LICENSE 文件）。 */
function findLicenseFile(paths) {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license', 'LICENCE', 'COPYING', 'LICENSE-BSD']
  for (const p of paths) {
    if (!existsSync(p)) continue
    for (const name of candidates) {
      const f = join(p, name)
      if (existsSync(f)) return f
    }
  }
  return null
}

function buildNotices(rows, grouped) {
  const now = new Date().toISOString().slice(0, 10)
  const projectVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
  const total = rows.length
  const L = []
  L.push('# 第三方依赖与许可证声明')
  L.push('')
  L.push('> 本文件由 `node scripts/gen-licenses.mjs` 基于 `pnpm licenses list` 的**实测安装结果**生成，请勿手工编辑。')
  L.push('')
  L.push(`- 项目：Zhuxing Harness v${projectVersion}（自身许可见仓库根目录 [LICENSE](../LICENSE)：源码可用 · 非商业免费 · 商业付费授权）`)
  L.push(`- 统计：**${total}** 个第三方包，覆盖 **${grouped.length}** 种许可证`)
  L.push(`- 生成日期：${now}`)
  L.push('- 范围：pnpm workspace 实际安装的全部依赖，**含传递依赖与开发依赖**（开发依赖虽不进发行物，但参与构建链路，一并声明）')
  L.push('')
  L.push('## 一、按许可证汇总')
  L.push('')
  L.push('| 许可证 | 包数 | 分发时的义务 |')
  L.push('| --- | ---: | --- |')
  for (const [license, list] of grouped) {
    L.push(`| \`${license}\` | ${list.length} | ${obligation(license)} |`)
  }
  L.push('')
  L.push('## 二、义务说明')
  L.push('')
  L.push('- **需保留声明**：MIT / ISC / BSD / Apache-2.0 / BlueOak / Python-2.0 / Artistic-2.0 等要求随分发物保留版权与许可声明。')
  L.push('  各依赖的完整原文见其包内 `LICENSE` 文件；代表性全文同时收录在 [texts/](./texts) 目录。')
  L.push('- **免声明**：0BSD / CC0-1.0 / MIT-0 / WTFPL 不要求保留声明（仍然列出，便于自查）。')
  L.push('- **需评估**：MPL-2.0（弱著佐权，修改其文件需回馈）、CC-BY-*（署名要求，多用于数据包）、')
  L.push('  Python-2.0 / Artistic-2.0（较老的非标准条款）。当前用法均为**未修改地作为依赖使用**，不触发额外义务；')
  L.push('  若将来要修改这些包或用其代码派生，需重新评估。')
  L.push('- **表达式**：形如 `(MIT OR CC0-1.0)` 的双许可，可择一遵守。')
  L.push('')
  L.push('## 三、完整清单')
  L.push('')
  for (const [license, list] of grouped) {
    L.push(`### ${license}（${list.length} 个，${obligation(license)}）`)
    L.push('')
    L.push('| 包 | 版本 | 作者 | 仓库 / 主页 |')
    L.push('| --- | --- | --- | --- |')
    for (const r of list) {
      const home = r.homepage ? `<${r.homepage}>` : ''
      L.push(`| \`${r.name}\` | ${r.versions} | ${r.author || ''} | ${home} |`)
    }
    L.push('')
  }
  return `${L.join('\n')}`
}

/** 为每种许可证落一份代表性原文，便于随发行物一并分发。 */
function writeTexts(grouped) {
  const written = []
  const skipped = []
  for (const [license, list] of grouped) {
    if (/[()]|\bOR\b|\bAND\b/.test(license)) {
      skipped.push(license)
      continue
    }
    const file = findLicenseFile(list.flatMap((r) => r.paths))
    if (!file) {
      skipped.push(license)
      continue
    }
    const body = readFileSync(file, 'utf-8').trim()
    const src = list[0]
    const header = [
      `许可证：${license}`,
      `代表性原文取自：${src.name}@${src.versions}（各依赖的实际版权行见其包内 LICENSE 文件）`,
      `来源文件：${file.slice(ROOT.length + 1)}`,
      '─'.repeat(60),
      '',
    ].join('\n')
    writeFileSync(join(TEXTS, `${license}.txt`), `${header}\n${body}\n`, 'utf-8')
    written.push(license)
  }
  return { written, skipped }
}

const byLicense = readLicenses()
const rows = flatten(byLicense)
const grouped = groupByLicense(rows)

if (checkOnly) {
  const target = join(OUT, 'THIRD-PARTY-NOTICES.md')
  if (!existsSync(target)) {
    console.error('✗ 缺少 licenses/THIRD-PARTY-NOTICES.md，请运行 node scripts/gen-licenses.mjs')
    process.exit(1)
  }
  const same = readFileSync(target, 'utf-8') === buildNotices(rows, grouped)
  if (!same) {
    console.error('✗ 依赖或许可证已变化，licenses/THIRD-PARTY-NOTICES.md 已过期：')
    console.error('  请运行 node scripts/gen-licenses.mjs 并提交更新。')
    process.exit(1)
  }
  console.log(`✓ 第三方声明与当前依赖一致（${rows.length} 个包 / ${grouped.length} 种许可证）`)
  process.exit(0)
}

mkdirSync(TEXTS, { recursive: true })
// 清掉上一次生成的原文，避免依赖变更后留下已不再使用的许可证文件
for (const f of readdirSync(TEXTS)) rmSync(join(TEXTS, f), { force: true })

writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES.md'), buildNotices(rows, grouped), 'utf-8')
const { written, skipped } = writeTexts(grouped)

console.log(`✓ licenses/THIRD-PARTY-NOTICES.md（${rows.length} 个包 / ${grouped.length} 种许可证）`)
console.log(`✓ licenses/texts/：收录 ${written.length} 份许可证原文`)
if (skipped.length) console.log(`  （未单独收录原文的许可证：${skipped.join('、')}——原文见各包自带 LICENSE 文件）`)
