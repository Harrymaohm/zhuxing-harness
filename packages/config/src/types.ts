import type { PluginModule } from '@zhuxing/harness-kernel'

/** 单个插件的配置（bundle / patch 中的一行）。 */
export interface PluginConfig {
  /** 插件唯一 id（与插件 name 一致）。 */
  id: string
  /** 插件模块路径（.ts / .js），或省略使用 inline。 */
  path?: string
  /** 内联插件定义（优先于 path）。 */
  inline?: PluginModule
  /** 插件配置。 */
  config?: Record<string, unknown>
  enabled?: boolean
}

/** bundle 文件：插件层的命名组合。 */
export interface BundleFile {
  name?: string
  description?: string
  plugins: Array<PluginConfig & { name?: string }>
}

/** patch 覆盖层操作。 */
export type PatchOp =
  | { op: 'insert'; id?: string; plugin: PluginConfig }
  | { op: 'replace'; id: string; plugin: PluginConfig }
  | { op: 'remove'; id: string }

/** profile 文件：引用 bundles + 覆盖 patch。 */
export interface ProfileFile {
  name?: string
  bundles: string[]
  patch?: PatchOp[]
}

export interface ResolveOptions {
  /** profile 文件路径。 */
  profile?: string
  /** patch 文件路径列表（按顺序应用，后者覆盖前者）。 */
  patches?: string[]
  /** 相对路径解析基准目录。 */
  cwd?: string
}

/** 解析结果：按挂载顺序排列的插件配置。 */
export interface ResolvedPlugins {
  plugins: PluginConfig[]
  sources: string[]
}
