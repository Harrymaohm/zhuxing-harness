/**
 * 筑星 Harness 桌面客户端（Electron 主进程）。
 *
 * 为什么要有它（而不是继续用浏览器标签页当外壳）：
 *
 * 1. **问题可见**。后端是本进程拉起来的子进程，它的 stdout/stderr 直接进日志文件与内存环形缓冲；
 *    启动失败、中途崩掉、健康检查不过，都能给出带日志尾巴的真实提示，而不是"页面白着"。
 * 2. **渲染不受浏览器策略摆布**。标签页会被浏览器节流、被内存回收、被别的页面拖死；
 *    这里是自己的窗口与渲染进程，崩溃能立刻重载并把原因记下来。
 * 3. **刷新不再丢状态**。窗口刷新后仍由本进程托管后端；配合后端的「在跑轮次」查询，
 *    界面可以重新挂上「停止」按钮，而不是刷新一次就再也停不下来。
 *
 * 主进程只做四件事：选端口、拉起后端、等健康、开窗并监管。业务逻辑一概不碰。
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const http = require('node:http')

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const HEALTH_TIMEOUT_MS = 45_000
const MAX_AUTO_RESTARTS = 3
/** 日志环：只保留最近若干行，够定位问题又不会把内存吃光。 */
const LOG_LIMIT = 600

let mainWindow = null
let backend = null
let backendLog = []
let logFile = ''
let baseUrl = ''
let quitting = false
let restartCount = 0

function log(line) {
  const text = `[${new Date().toLocaleTimeString('zh-CN')}] ${line}`
  backendLog.push(text)
  if (backendLog.length > LOG_LIMIT) backendLog.splice(0, backendLog.length - LOG_LIMIT)
  if (logFile) {
    try {
      appendFileSync(logFile, `${text}\n`, 'utf-8')
    } catch {
      /* 日志写不进去不该影响主流程 */
    }
  }
  process.stdout.write(`${text}\n`)
}

function logTail(n = 14) {
  return backendLog.slice(-n).join('\n') || '（暂无日志）'
}

/** 选一个空闲端口：避免与已安装版本固定的 54443 抢端口。 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolvePort(port))
    })
  })
}

/** 解析后端启动方式：安装态用自带 node + shell；开发态用仓库里的 Web 服务。 */
function backendCommand(port) {
  const packagedApp = process.resourcesPath ? join(process.resourcesPath, 'app') : ''
  const packagedShell = packagedApp ? join(packagedApp, 'bin', 'harness.cjs') : ''
  if (packagedShell && existsSync(packagedShell)) {
    const nodeExe = join(packagedApp, 'node', 'node.exe')
    return {
      mode: 'packaged',
      command: existsSync(nodeExe) ? nodeExe : process.execPath,
      args: [packagedShell, 'web', '--port', String(port)],
      cwd: packagedApp,
      env: { ...process.env, HARNESS_ROOT: packagedApp, HARNESS_WEB_UI_DIR: join(packagedApp, 'web', 'dist-ui') },
    }
  }
  const webEntry = join(REPO_ROOT, 'packages', 'web', 'dist', 'index.js')
  return {
    mode: 'dev',
    command: process.execPath,
    args: [webEntry, '--port', String(port)],
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
}

function startBackend(port) {
  const spec = backendCommand(port)
  log(`启动后端（${spec.mode}）：${spec.command} ${spec.args.join(' ')}`)
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => log(`[后端] ${String(d).trim()}`))
  child.stderr.on('data', (d) => log(`[后端:err] ${String(d).trim()}`))
  child.once('error', (err) => log(`后端进程启动失败：${err.message}`))
  child.once('exit', (code, signal) => {
    backend = null
    if (quitting) return
    log(`后端进程退出（code=${code} signal=${signal}）`)
    scheduleRestart()
  })
  return child
}

function scheduleRestart() {
  if (quitting) return
  if (restartCount >= MAX_AUTO_RESTARTS) {
    log(`连续 ${restartCount} 次重启失败，停止自动重启`)
    void dialog.showMessageBox({
      type: 'error',
      title: '后端反复退出',
      message: `后端进程已连续 ${restartCount} 次异常退出，已停止自动重启。`,
      detail: logTail(),
      buttons: ['打开日志目录', '好'],
      defaultId: 1,
    }).then((r) => {
      if (r.response === 0) shell.showItemInFolder(logFile)
    })
    return
  }
  restartCount += 1
  const delay = 800 * restartCount
  log(`将在 ${delay}ms 后重启后端（第 ${restartCount}/${MAX_AUTO_RESTARTS} 次）`)
  setTimeout(() => {
    if (quitting) return
    void boot()
  }, delay)
}

function healthOk(url) {
  return new Promise((resolveOk) => {
    const req = http.get(`${url}/api/health`, { timeout: 2500 }, (res) => {
      res.resume()
      resolveOk(res.statusCode >= 200 && res.statusCode < 300)
    })
    req.on('timeout', () => {
      req.destroy()
      resolveOk(false)
    })
    req.on('error', () => resolveOk(false))
  })
}

async function waitHealthy(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthOk(url)) return true
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

async function boot() {
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  backend = startBackend(port)
  const ok = await waitHealthy(baseUrl)
  if (!ok) {
    log(`后端在 ${HEALTH_TIMEOUT_MS}ms 内未通过健康检查：${baseUrl}/api/health`)
    await dialog.showMessageBox({
      type: 'error',
      title: '后端启动失败',
      message: '本地服务未能就绪，界面无法加载。',
      detail: logTail(),
      buttons: ['打开日志目录', '重试', '退出'],
      defaultId: 1,
    }).then(async (r) => {
      if (r.response === 0) shell.showItemInFolder(logFile)
      else if (r.response === 1) await boot()
      else app.quit()
    })
    return
  }
  restartCount = 0
  log(`后端就绪：${baseUrl}`)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(baseUrl)
}

function reloadWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  log(`重新加载窗口：${reason}`)
  mainWindow.loadURL(baseUrl)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '筑星 Harness',
    backgroundColor: '#07090d',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 后端是本机服务，渲染进程只需普通网页权限
      sandbox: true,
    },
  })

  // 渲染进程崩了 / 卡住：立刻重载并把原因写进日志，用户不必自己发现"页面不动了"
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`渲染进程结束（${details.reason}），将重新加载`)
    reloadWindow('render-process-gone')
  })
  mainWindow.webContents.on('unresponsive', () => {
    log('渲染进程无响应')
    void dialog.showMessageBox({
      type: 'warning',
      title: '界面无响应',
      message: '界面进程没有响应，通常是某个页面脚本卡住了。',
      detail: logTail(8),
      buttons: ['重新加载', '继续等待'],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0) reloadWindow('unresponsive')
    })
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`页面加载失败（${code} ${desc}）：${url}`)
  })
  mainWindow.webContents.on('did-finish-load', () => log('窗口已加载完成'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.loadURL(baseUrl)
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => reloadWindow('手动') },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: '打开日志目录', click: () => shell.showItemInFolder(logFile) },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '服务',
      submenu: [
        {
          label: '重启后端',
          click: () => {
            log('手动重启后端')
            restartCount = 0
            if (backend) backend.kill()
            else void boot()
          },
        },
        {
          label: '在浏览器中打开',
          click: () => {
            if (baseUrl) void shell.openExternal(baseUrl)
          },
        },
        { type: 'separator' },
        {
          label: '查看最近日志',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: '最近日志',
              message: `后端地址：${baseUrl || '(未启动)'}`,
              detail: logTail(30),
              buttons: ['打开日志目录', '好'],
              defaultId: 1,
            }).then((r) => {
              if (r.response === 0) shell.showItemInFolder(logFile)
            }),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 单实例：再次双击只聚焦已有窗口，不再起一套后端
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'backend.log')
    writeFileSync(logFile, `=== 启动于 ${new Date().toLocaleString('zh-CN')} ===\n`, 'utf-8')
    buildMenu()
    if (process.argv.includes('--dev')) mainWindow?.webContents.openDevTools()
    await boot()
    createWindow()
  }).catch((err) => {
    // 启动链（拉起后端 / 等健康 / 建窗口）任一环节失败都必须留下可见诊断：
    // 没有这一步时 Electron 只是白屏，用户看不到原因、日志里也什么都没有。
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    try {
      if (logFile) appendFileSync(logFile, `启动失败：${detail}\n`, 'utf-8')
    } catch {
      // 日志写不进去也不能掩盖原始错误，继续走下面的可见提示
    }
    dialog.showErrorBox('筑星 Harness 启动失败', detail)
    app.quit()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
    if (backend) backend.kill()
  })
}
