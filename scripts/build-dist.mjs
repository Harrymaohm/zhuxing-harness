/**
 * 组装安装包内容目录（dist-install/app/）：
 *   node/node.exe           便携 Node 运行时（来自 tools/）
 *   bin/harness.cjs         单文件 CLI（含全部命令，web 依赖 dist-ui）
 *   web/dist-ui/            Web UI 静态资源
 *   node_modules/esbuild/   运行时依赖（TS 插件转译）
 *   harness.cmd             启动器（注入 HARNESS_WEB_UI_DIR，调用 node.exe）
 *
 * 前置：pnpm -r build && pnpm bundle && pnpm --filter @zhuxing/harness-web build:ui
 * 运行：node scripts/build-dist.mjs
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TOOLS = join(ROOT, 'tools')
const OUT = join(ROOT, 'dist-install')
const APP = join(OUT, 'app')

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
const version = rootPkg.version ?? '0.0.0'

/** 递归复制目录（规避 Node cpSync 在含中文路径下的原生崩溃）。 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

function need(path, hint) {
  if (!existsSync(path)) {
    console.error(`✗ 缺少 ${path}。请先运行：${hint}`)
    process.exit(1)
  }
}

function main() {
  // 1. 前置产物校验
  need(join(ROOT, 'dist-bin', 'harness.cjs'), 'pnpm build && pnpm bundle')
  need(join(ROOT, 'packages', 'web', 'dist-ui', 'index.html'), 'pnpm --filter @zhuxing/harness-web build:ui')
  need(join(TOOLS, 'node', 'node-v22.14.0-win-x64', 'node.exe'), '下载便携 Node 到 tools/')
  need(join(TOOLS, 'nsis', 'nsis-3.10', 'makensis.exe'), '下载 NSIS 到 tools/')

  // 2. 清空并重建 app 目录
  rmSync(APP, { recursive: true, force: true })
  mkdirSync(join(APP, 'node'), { recursive: true })
  mkdirSync(join(APP, 'bin'), { recursive: true })
  mkdirSync(join(APP, 'web'), { recursive: true })
  mkdirSync(join(APP, 'node_modules'), { recursive: true })

  // 3. 便携 Node
  copyFileSync(join(TOOLS, 'node', 'node-v22.14.0-win-x64', 'node.exe'), join(APP, 'node', 'node.exe'))
  console.log('✓ node/node.exe')

  // 4. 单文件 CLI
  copyFileSync(join(ROOT, 'dist-bin', 'harness.cjs'), join(APP, 'bin', 'harness.cjs'))
  console.log('✓ bin/harness.cjs')

  // 5. Web UI 静态资源
  copyDir(join(ROOT, 'packages', 'web', 'dist-ui'), join(APP, 'web', 'dist-ui'))
  console.log('✓ web/dist-ui')

  // 6. esbuild 运行时依赖（TS 插件转译）
  const esbuildDir = findEsbuildDir()
  if (!esbuildDir) {
    console.error('✗ 未找到 esbuild 包目录（node_modules/.pnpm/esbuild*/node_modules/esbuild）')
    process.exit(1)
  }
  copyDir(esbuildDir, join(APP, 'node_modules', 'esbuild'))
  console.log('✓ node_modules/esbuild')

  // 7. 启动器
  const launcher = `@echo off
setlocal
set "HARNESS_ROOT=%~dp0"
set "HARNESS_WEB_UI_DIR=%HARNESS_ROOT%web\\dist-ui"
"%HARNESS_ROOT%node\\node.exe" "%HARNESS_ROOT%bin\\harness.cjs" %*
exit /b %errorlevel%
`
  writeFileSync(join(APP, 'harness.cmd'), launcher, 'utf-8')
  console.log('✓ harness.cmd')

  // 8. 版本信息
  writeFileSync(join(APP, 'VERSION'), `${version}\n`, 'utf-8')
  console.log(`✓ app 目录就绪：${APP}（v${version}）`)
}

function findEsbuildDir() {
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  for (const entry of readdirSync(pnpmDir)) {
    if (entry.startsWith('esbuild@')) {
      const candidate = join(pnpmDir, entry, 'node_modules', 'esbuild')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

main()
