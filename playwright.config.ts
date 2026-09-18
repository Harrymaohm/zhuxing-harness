import { defineConfig } from '@playwright/test'

/**
 * Web 前端端到端测试（计划案「P2-1 五条主流程」）。
 *
 * 被测对象是**真实交付形态**：`packages/web/dist` 的 Web 服务 + `packages/web/dist-ui` 的前端产物，
 * 上游模型由本地流式 mock 顶替（`tests/e2e-ui/streaming-mock.mjs`），因此零 token 成本、可复算。
 *
 * 浏览器渠道：本地没有 Playwright 自带 Chromium 时用环境变量指定系统浏览器，例如
 *   PowerShell: $env:PLAYWRIGHT_CHANNEL='msedge'; pnpm test:e2e:ui
 *   cmd:        set PLAYWRIGHT_CHANNEL=msedge&& pnpm test:e2e:ui
 * CI 不设该变量 → 用 `npx playwright install --with-deps chromium` 装好的自带 Chromium。
 */
const PORT = Number(process.env.E2E_WEB_PORT ?? 4319)
const BASE_URL = `http://127.0.0.1:${PORT}`
const channel = process.env.PLAYWRIGHT_CHANNEL?.trim()

export default defineConfig({
  testDir: './tests/e2e-ui',
  // 只认 *.e2e.ts：与 vitest 默认的 *.test.* / *.spec.* 分离，
  // 否则 `pnpm test:e2e`（vitest）会把 Playwright 用例也当成自己的用例。
  testMatch: '**/*.e2e.ts',
  // 五条流程共用同一个 Web 服务与 mock，串行执行避免互相干扰
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'coverage/playwright/report', open: 'never' }]]
    : [['list']],
  // 产物落在已被 .gitignore 覆盖的 coverage/ 下
  outputDir: 'coverage/playwright/test-results',
  use: {
    baseURL: BASE_URL,
    channel: channel || undefined,
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node tests/e2e-ui/harness.mjs',
    url: `${BASE_URL}/api/health`,
    env: { E2E_WEB_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
