#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startWebServer } from './server.js'

const argv = process.argv.slice(2)

// --stop：读取锁文件，优雅停止常驻服务（无需另行开终端）
if (argv.includes('--stop')) {
  const lockFile = join(homedir(), '.zhuxing-harness', 'web.pid')
  try {
    const raw = readFileSync(lockFile, 'utf-8')
    const m = /^(\d+)\s+/.exec(raw.trim())
    if (m) {
      process.kill(Number(m[1]), 'SIGTERM')
      rmSync(lockFile, { force: true })
      console.log('✓ 已请求停止 Harness Web 服务。')
    } else {
      console.log('未找到运行中的服务。')
    }
  } catch {
    console.log('未找到运行中的服务。')
  }
  process.exit(0)
}

const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 3080
const hostArg = argv.indexOf('--host')
const host = hostArg >= 0 ? argv[hostArg + 1] : '127.0.0.1'

const handle = await startWebServer({ port, host })
console.log(`筑星 Harness Web UI 已启动：${handle.url}`)
console.log('（服务常驻，Ctrl-C 退出）')

process.on('SIGINT', async () => {
  await handle.dispose()
  handle.server.close()
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await handle.dispose()
  handle.server.close()
  process.exit(0)
})
