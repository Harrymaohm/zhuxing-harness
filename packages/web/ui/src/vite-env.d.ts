/// <reference types="vite/client" />

// pptx-wasm 以子路径导出 .wasm 资源，通过 Vite 的 `?url` 以静态资源 URL 引入
declare module 'pptx-wasm/wasm?url' {
  const src: string
  export default src
}
