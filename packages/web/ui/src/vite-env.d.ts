/// <reference types="vite/client" />

/** 构建期由 vite.config.ts 的 define 注入的界面版本号（与 packages/web/package.json 一致）。 */
declare const __UI_VERSION__: string

// pptx-wasm 以子路径导出 .wasm 资源，通过 Vite 的 `?url` 以静态资源 URL 引入
declare module 'pptx-wasm/wasm?url' {
  const src: string
  export default src
}
