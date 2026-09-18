/**
 * electron-builder afterPack 钩子：把 build-dist 组装好的后端载荷原样复制进
 * <appOutDir>/resources/app（与 main.cjs packed 分支的 resourcesPath/app 约定对齐）。
 *
 * 为什么不用 extraResources：它的文件收集器会按默认规则剥掉 node_modules 与点开头目录，
 * 而 esbuild（TS 插件转译的运行时依赖）必须随包保留；这里用递归复制，行为完全可控。
 */
const { copyFileSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const PAYLOAD = resolve(__dirname, '..', '..', '..', 'dist-install', 'app')

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const stat = statSync(PAYLOAD, { throwIfNoEntry: false })
  if (!stat || !stat.isDirectory()) {
    throw new Error(`afterPack：缺少后端载荷目录 ${PAYLOAD}，请先运行 node scripts/build-dist.mjs`)
  }
  const target = join(context.appOutDir, 'resources', 'app')
  copyTree(PAYLOAD, target)
  console.log(`✓ afterPack：载荷已复制到 ${target}`)
}
