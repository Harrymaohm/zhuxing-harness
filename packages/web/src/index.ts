#!/usr/bin/env node
import { startWebServer } from './server.js'

const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 3080
const hostArg = argv.indexOf('--host')
const host = hostArg >= 0 ? argv[hostArg + 1] : '127.0.0.1'

const handle = await startWebServer({ port, host })
console.log(`筑星 Harness Web UI 已启动：${handle.url}`)
console.log('（Ctrl-C 退出）')

process.on('SIGINT', () => {
  handle.server.close()
  process.exit(0)
})
