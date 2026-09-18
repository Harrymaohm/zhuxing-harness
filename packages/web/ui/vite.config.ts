import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 构建期把界面版本号嵌进产物：运行期拿它和 /api/bootstrap 返回的服务端版本比对，
// 不一致说明浏览器还在跑旧包（更新后未刷新），由 VersionBanner 提示刷新。
const UI_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }
).version ?? '0.0.0'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: { __UI_VERSION__: JSON.stringify(UI_VERSION) },
  // pptx-wasm 的 .wasm 通过 `pptx-wasm/wasm?url` 显式引入并作为静态资源发射
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['pptx-wasm'],
  },
  build: {
    outDir: fileURLToPath(new URL('../dist-ui', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3080',
    },
  },
})
