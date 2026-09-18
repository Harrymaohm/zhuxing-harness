/**
 * E2E UI 的启动脚本（Playwright `webServer.command` 指向它）。
 *
 * 一个进程内同时拉起两件事：
 *   1. 流式模型 mock（`streaming-mock.mjs`）——被测 Web 服务的上游；
 *   2. 真实 Web 服务（`packages/web/dist/server.js` 的 `startWebServer`）。
 *
 * 环境接线要点（避免污染真实用户数据）：
 *   - `HARNESS_CONFIG` / `HARNESS_SESSION_DIR` / `HARNESS_MEMORY_PATH` /
 *     `HARNESS_KNOWLEDGE_DIR` / `HARNESS_SPECS_DIR` 全部指向本次运行的临时目录；
 *   - `HARNESS_WEB_UI_DIR` 指向 `packages/web/dist-ui`（由 `pnpm -C packages/web build:ui` 产出）；
 *   - 显式删除 `HARNESS_ACCESS_TOKEN`：E2E 不需要认证（设了反而要带 `X-Harness-Token`）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { startStreamingMock } from './streaming-mock.mjs'

const require = createRequire(import.meta.url)
const fixtures = require('./fixtures.json')

const HERE = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(HERE, '..', '..')
const serverEntry = join(repoRoot, 'packages', 'web', 'dist', 'server.js')
const uiDir = join(repoRoot, 'packages', 'web', 'dist-ui')

function fail(message) {
  console.error(`[e2e-ui] ${message}`)
  process.exit(1)
}

if (!existsSync(serverEntry)) fail(`未找到 Web 服务产物：${serverEntry}（请先运行 pnpm -r build）`)
if (!existsSync(join(uiDir, 'index.html'))) fail(`未找到前端产物：${uiDir}（请先运行 pnpm -C packages/web build:ui）`)

const port = Number(process.env.E2E_WEB_PORT ?? fixtures.webPort)
const workDir = mkdtempSync(join(tmpdir(), 'zhuxing-e2e-ui-'))
const workspace = join(workDir, 'workspace')
const sessionDir = join(workDir, 'sessions')
mkdirSync(workspace, { recursive: true })
mkdirSync(sessionDir, { recursive: true })
// 工作区里放一个文本文件，供「预览文件」流程通过界面点开
writeFileSync(join(workspace, fixtures.previewFileName), `${fixtures.previewFileContent}\n`, 'utf-8')

const mock = await startStreamingMock()

const configPath = join(workDir, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      apiKey: 'e2e-mock-key',
      baseUrl: mock.baseUrl,
      model: 'e2e-mock-model',
      workspace,
      level: 'workspace-write',
      sessionDir,
      // 关掉指令精炼：E2E 只验证界面主流程，少一次模型调用 = 更短的等待与更稳的断言
      refineInstruction: fixtures.refineDisabled ? false : undefined,
    },
    null,
    2,
  ),
  'utf-8',
)

process.env.HARNESS_CONFIG = configPath
process.env.HARNESS_SESSION_DIR = sessionDir
process.env.HARNESS_MEMORY_PATH = join(workDir, 'memories.json')
process.env.HARNESS_KNOWLEDGE_DIR = join(workDir, 'knowledge')
process.env.HARNESS_SPECS_DIR = join(workDir, 'specs')
process.env.HARNESS_WEB_UI_DIR = uiDir
delete process.env.HARNESS_ACCESS_TOKEN
delete process.env.HARNESS_ROOT
delete process.env.HARNESS_PLAN_MODE

const { startWebServer } = await import(pathToFileURL(serverEntry).href)
const handle = await startWebServer({ port, host: '127.0.0.1' })

console.log(`[e2e-ui] web 服务已就绪：${handle.url}（mock 上游 ${mock.baseUrl}，工作区 ${workspace}）`)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await new Promise((resolve) => handle.server.close(() => resolve()))
  } catch {
    /* 进程退出路径，尽力而为 */
  }
  try {
    await mock.stop()
  } catch {
    /* 同上 */
  }
  try {
    await handle.dispose()
  } catch {
    /* 同上 */
  }
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* Windows 上文件可能仍被占用，临时目录留着无妨 */
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0))
  })
}
