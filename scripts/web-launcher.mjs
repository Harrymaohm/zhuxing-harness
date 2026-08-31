import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = join(root, 'node', 'node.exe')
const cli = join(root, 'bin', 'harness.cjs')
const lockDir = join(homedir(), '.zhuxing-harness')
const lockFile = join(lockDir, 'web.pid')

/** 兜底：杀掉所有仍在运行的 ZhuxingHarness node 进程（残留实例会占用文件导致无法写入）。 */
function stopAllHarnessProcesses() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    `Where-Object { $_.ExecutablePath -like '*ZhuxingHarness*' -and $_.ProcessId -ne ${process.pid} } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 10000,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    /* 已全部停止或系统无该进程 */
  }
}

// --stop：停止锁文件记录的服务进程，兜底清理全部残留进程并删除锁
if (process.argv.includes('--stop')) {
  const existing = readLock()
  if (existing) {
    try {
      process.kill(existing.pid, 'SIGTERM')
    } catch {
      /* 进程已不存在 */
    }
    try {
      rmSync(lockFile, { force: true })
    } catch {
      /* ignore */
    }
  }
  stopAllHarnessProcesses()
  console.log('✓ 已停止 Harness Web 服务。')
  process.exit(0)
}

// 本地认证 token：每次启动生成，注入子进程环境；本机浏览器经 /api/bootstrap 获取
const accessToken = randomBytes(24).toString('hex')

/** 进程存活检测（Windows 友好）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readLock() {
  try {
    const raw = readFileSync(lockFile, 'utf-8')
    const line = raw.split('\n').find((l) => l.trim())
    if (!line) return null
    const m = /^(\d+)\s+(https?:\/\/\S+)/.exec(line.trim())
    return m ? { pid: Number(m[1]), url: m[2] } : null
  } catch {
    return null
  }
}

const HEALTH_TIMEOUT = 2500

/** 服务连通性验证：请求免认证的 /api/health，2xx 视为存活。 */
function isServiceHealthy(url) {
  return new Promise((resolve) => {
    const req = get(`${url}/api/health`, { timeout: HEALTH_TIMEOUT }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 300)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

/**
 * 可靠打开浏览器并等待拉起完成。
 * 优先 `cmd /c start`（对已运行的默认浏览器也会新建窗口/标签），失败兜底 rundll32；
 * 返回 Promise 在打开动作完成后 resolve，避免 process.exit 过早终止浏览器拉起。
 */
function openBrowser(url) {
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, (err) => {
      if (err) {
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => resolve())
      } else {
        resolve()
      }
    })
  })
}

// 单实例：已有服务在跑 → 校验端口真实可用后复用，只打开浏览器后退出（不重复启动）
const existing = readLock()
if (existing && isAlive(existing.pid) && (await isServiceHealthy(existing.url))) {
  await openBrowser(existing.url)
  process.exit(0)
}
// 陈旧锁清理（服务已死 / 端口不可达 / 锁损坏）
try {
  rmSync(lockFile, { force: true })
} catch {
  /* ignore */
}

// 锁丢失/损坏但固定端口上已有服务在跑：直接复用打开浏览器，避免重复启动失败
if (await isServiceHealthy('http://127.0.0.1:54443')) {
  await openBrowser('http://127.0.0.1:54443')
  process.exit(0)
}

// 固定端口：重复双击/服务重启后地址不变，配合上方单实例检测稳定复用已有链接
const child = spawn(node, [cli, 'web', '--port', '54443'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
  env: {
    ...process.env,
    HARNESS_ACCESS_TOKEN: accessToken,
    HARNESS_WEB_UI_DIR: join(root, 'web', 'dist-ui'),
    HARNESS_ICON_PATH: join(root, 'harness.ico'),
    HARNESS_ROOT: root,
  },
})

let opened = false
let output = ''

const saveLock = (url) => {
  try {
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(lockFile, `${child.pid} ${url}\n`, 'utf-8')
  } catch {
    /* ignore */
  }
}

child.stdout.on('data', (chunk) => {
  output += chunk.toString()
  const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/)
  if (match && !opened) {
    opened = true
    saveLock(match[0])
    openBrowser(match[0])
  }
  if (output.length > 4096) output = output.slice(-2048)
})

const clearLock = () => {
  try {
    rmSync(lockFile, { force: true })
  } catch {
    /* ignore */
  }
}

const stop = () => {
  clearLock()
  if (!child.killed) child.kill()
}

child.once('error', (error) => {
  clearLock()
  console.error(`无法启动 Harness Web 服务：${error.message}`)
  process.exitCode = 1
})
process.once('SIGINT', () => {
  stop()
  process.exit(0)
})
process.once('SIGTERM', stop)
// 服务常驻：子进程退出后守护退出并清理锁；未成功打开浏览器时兜底探测固定地址
child.once('exit', async (code) => {
  clearLock()
  if (!opened && (await isServiceHealthy('http://127.0.0.1:54443'))) {
    // 服务实际已在运行（如端口被既有实例占用导致本实例退出），打开固定地址
    await openBrowser('http://127.0.0.1:54443')
  }
  process.exit(code ?? 0)
})
