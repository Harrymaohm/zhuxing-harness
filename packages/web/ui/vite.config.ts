import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
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
