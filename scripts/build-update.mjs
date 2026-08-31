/**
 * 生成应用内增量更新包 + manifest.json。
 * 从 dist-install/app 提取「会变化的文件」打包为 zip，计算 sha256，生成更新清单。
 * 前置：pnpm build && pnpm bundle && pnpm --filter @zhuxing/harness-web build:ui && node scripts/build-dist.mjs
 * 运行：node scripts/build-update.mjs
 * 输出：dist-update/harness-update-<版本>.zip + manifest.json
 */
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP = join(ROOT, 'dist-install', 'app')
const OUT = join(ROOT, 'dist-update')

/** 增量包包含的相对路径（会变的文件；node.exe / esbuild 不下发）。 */
const INCLUDE = [
  'bin/harness.cjs',
  'bin/web-launcher.mjs',
  'bin/launch.vbs',
  'web/dist-ui',
  'harness.cmd',
  'harness-web.cmd',
  'harness.ico',
  'VERSION',
]

function main() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
  const zipName = `harness-update-${version}.zip`

  // 校验来源目录
  if (!existsSync(join(APP, 'bin', 'harness.cjs'))) {
    console.error('✗ 缺少 dist-install/app/bin/harness.cjs。请先运行 build-dist。')
    process.exit(1)
  }

  mkdirSync(OUT, { recursive: true })

  // 构建 zip
  const zip = new AdmZip()
  for (const rel of INCLUDE) {
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

  // manifest.json
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
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  console.log(`✓ 增量包：${zipPath}`)
  console.log(`✓ 大小：${size} 字节`)
  console.log(`✓ sha256：${sha256}`)
  console.log(`✓ manifest：${join(OUT, 'manifest.json')}`)
  console.log('\n部署到更新源时，把 dist-update/ 整个目录作为静态站点根即可。')
}

main()
