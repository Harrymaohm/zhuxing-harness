import react from '@vitejs/plugin-react'
import { defineConfig, type UserConfig } from 'vitest/config'

/**
 * 前端测试配置。
 *
 * - 默认 node 环境：服务端测试（__tests__/server.test.ts）不需要 DOM。
 * - UI 测试在文件头用 `// @vitest-environment jsdom` 单独声明，
 *   避免给服务端测试挂上无用的 DOM 环境。
 * - setup 只在 jsdom 下生效（见 ui/__tests__/setup.ts）。
 */
export default defineConfig({
  /**
   * 类型说明：vitest 3.x 内部解析出的 vite（经 @vitest/mocker）与本包的 vite@6
   * 是两套 Plugin 类型，直接赋值会报类型冲突；两者运行时兼容。
   * 不用全局 pnpm override 把 vite 钉到单一版本：实测会改变 vitest 的 vite-node
   * 对 Temp 目录动态 import 的加载行为，打破 packages/config 的转译缓存测试。
   */
  plugins: [react()] as UserConfig['plugins'],
  test: {
    environment: 'node',
    setupFiles: ['./ui/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['ui/src/**/*.{ts,tsx}'],
      exclude: ['ui/src/**/*.d.ts', 'ui/src/vite-env.d.ts'],
      reporter: ['text-summary'],
      /**
       * 分目录门槛（而不是全局一个数）：
       * App.tsx 是 2400+ 行的集成壳（会话/流式/布局装配），只有浏览器级测试才能有效覆盖它；
       * 把它算进全局只会把整体数字稀释成无意义的个位数，反而不如给真正可单测的模块下硬指标。
       *
       * `ui/src/views/**`（FilePreview / KnowledgeGraph / SettingsModal / Panels）同样不设门槛：
       * 这些是含 WebGL（three）与 wasm（pptx）的视图组件，jsdom 里根本跑不起来；
       * 它们原先都写在 App.tsx 内部（本就不在门槛覆盖范围内），拆成独立文件是为了按需加载，
       * 不应因此把它们凭空拉进门槛、更不应为凑数补渲染快照测试。
       */
      thresholds: {
        'ui/src/lib/**': { statements: 95, lines: 95, functions: 95, branches: 85 },
        /**
         * 0.3.21 ratchet（计划书 P0-4，只升不降）：
         * 补齐 markdown/dock/terminal 行为测试后实测 97.17/92.55，门槛从 35/70 升到 50/80，
         * 留出回归余量又足以拦住"删测试降质量"的改动。
         */
        'ui/src/components/**': { statements: 50, lines: 50, functions: 40, branches: 80 },
      },
    },
  },
})
