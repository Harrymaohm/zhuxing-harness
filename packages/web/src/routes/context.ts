import type { RuntimeManager } from '../runtime.js'
import type { StaticAssets } from '../http.js'

/**
 * 路由处理器共享的请求上下文。
 *
 * path/url 在入口解析一次后透传，避免各处理器重复解析（且保证鉴权与路由看到的是同一个 path）。
 * 各处理器只从 ctx 取自己用得到的字段，避免 tsc 的 noUnusedLocals 报错。
 */
export interface RouteContext {
  runtime: RuntimeManager
  staticAssets: StaticAssets
  accessToken: string
  url: URL
  path: string
}
