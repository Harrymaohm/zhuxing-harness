import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { PluginModule } from '@zhuxing/harness-kernel'
import type {
  BundleFile,
  PatchOp,
  PluginConfig,
  ProfileFile,
  ResolveOptions,
  ResolvedPlugins,
} from './types.js'

/** 读取并解析 YAML 文件。 */
export async function loadYaml<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8')
  return parseYaml(content) as T
}

/** 单进程内并发转译同一文件的互斥锁（避免重复 build）。 */
const buildLocks = new Map<string, Promise<unknown>>()

function withBuildLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = buildLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  buildLocks.set(key, next)
  void next.finally(() => {
    if (buildLocks.get(key) === next) buildLocks.delete(key)
  })
  return next
}

/**
 * 加载插件模块：
 * - .ts/.tsx/.mts 用 esbuild 转译为 ESM 后 import。
 * - **内容哈希缓存**：产物文件名由文件内容哈希决定，内容未变时跳过重复构建（热启动显著提速）。
 * - .js/.mjs 直接 import。
 * 返回模块的 default 导出（或模块本身）。
 */
export async function loadPluginModule(filePath: string): Promise<PluginModule> {
  const abs = resolve(filePath)
  const ext = abs.toLowerCase()
  if (ext.endsWith('.ts') || ext.endsWith('.tsx') || ext.endsWith('.mts')) {
    const content = await readFile(abs, 'utf-8')
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
    const cacheDir = join(dirname(abs), '.harness-cache')
    const outfile = join(cacheDir, `${basename(abs).replace(/\.(tsx?|mts)$/, '')}-${hash}.mjs`)

    if (!existsSync(outfile)) {
      await withBuildLock(abs, async () => {
        // 锁内二次检查：并发时避免重复构建
        if (existsSync(outfile)) return
        await mkdir(cacheDir, { recursive: true })
        await build({
          entryPoints: [abs],
          bundle: false,
          platform: 'node',
          format: 'esm',
          outfile,
          sourcemap: false,
          target: 'node20',
          logLevel: 'silent',
        })
      })
    }
    const mod = (await import(pathToFileURL(outfile).href)) as Record<string, unknown>
    return (mod.default ?? mod) as PluginModule
  }
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>
  return (mod.default ?? mod) as PluginModule
}

/** 解析 patch 文件为操作序列；兼容 { patch: [...] } 与 { plugins: [...] } 两种格式。 */
export async function loadPatchFile(filePath: string): Promise<PatchOp[]> {
  const data = (await loadYaml<Record<string, unknown>>(filePath)) ?? {}
  if (Array.isArray(data.patch)) return data.patch as PatchOp[]
  if (Array.isArray(data.plugins)) {
    return (data.plugins as Array<PluginConfig & { name?: string }>).map((p) => ({
      op: 'insert' as const,
      id: p.id,
      plugin: { id: p.id, path: p.path, inline: p.inline, config: p.config, enabled: p.enabled },
    }))
  }
  throw new Error(`[config] patch 文件 "${filePath}" 缺少 plugins 或 patch 字段`)
}

/** 将 patch 操作中插件的相对路径按 baseDir 归一化为绝对路径。 */
function normalizePluginPaths(patch: PatchOp[], baseDir: string): PatchOp[] {
  return patch.map((op) => {
    if (op.op === 'insert' || op.op === 'replace') {
      const p = op.plugin
      if (p.path) return { ...op, plugin: { ...p, path: resolve(baseDir, p.path) } }
    }
    return op
  })
}

/** 应用 patch 序列到插件列表（insert / replace / remove）。 */
export function applyPatch(plugins: PluginConfig[], patch: PatchOp[]): PluginConfig[] {
  const result = [...plugins]
  for (const op of patch) {
    switch (op.op) {
      case 'insert': {
        const id = op.plugin.id ?? op.id
        if (!id) throw new Error('[config] insert 操作必须提供插件 id')
        const existing = result.findIndex((p) => p.id === id)
        const entry = { ...op.plugin, id }
        if (existing >= 0) result[existing] = entry
        else result.push(entry)
        break
      }
      case 'replace': {
        const idx = result.findIndex((p) => p.id === op.id)
        if (idx < 0) throw new Error(`[config] replace 目标 "${op.id}" 不存在`)
        result[idx] = { ...op.plugin, id: op.id }
        break
      }
      case 'remove': {
        const idx = result.findIndex((p) => p.id === op.id)
        if (idx >= 0) result.splice(idx, 1)
        break
      }
    }
  }
  return result
}

/**
 * 分层解析：profile → bundle → patch → 合并。
 * 任一层的插件行都可用下一层 patch 覆盖（insert 同 id 覆盖 / replace / remove）。
 */
export async function resolvePlugins(options: ResolveOptions): Promise<ResolvedPlugins> {
  const cwd = options.cwd ?? process.cwd()
  const sources: string[] = []
  let plugins: PluginConfig[] = []

  if (options.profile) {
    const profilePath = resolve(cwd, options.profile)
    const profile = await loadYaml<ProfileFile>(profilePath)
    sources.push(profilePath)
    for (const bundle of profile.bundles ?? []) {
      const bundlePath = resolve(cwd, bundle)
      const bundleFile = await loadYaml<BundleFile>(bundlePath)
      sources.push(bundlePath)
      const bundlePlugins: PluginConfig[] = (bundleFile.plugins ?? []).map((p) => ({
        id: p.id ?? p.name!,
        path: p.path ? resolve(dirname(bundlePath), p.path) : p.path,
        inline: p.inline,
        config: p.config,
        enabled: p.enabled ?? true,
      }))
      plugins = mergePlugins(plugins, bundlePlugins)
    }
    if (profile.patch) plugins = applyPatch(plugins, normalizePluginPaths(profile.patch, dirname(profilePath)))
  }

  for (const patchFile of options.patches ?? []) {
    const patchPath = resolve(cwd, patchFile)
    const patch = await loadPatchFile(patchPath)
    sources.push(patchPath)
    plugins = applyPatch(plugins, normalizePluginPaths(patch, dirname(patchPath)))
  }

  return { plugins, sources }
}

/** 合并插件列表：同 id 后到覆盖先到。 */
function mergePlugins(a: PluginConfig[], b: PluginConfig[]): PluginConfig[] {
  const map = new Map<string, PluginConfig>()
  for (const p of [...a, ...b]) map.set(p.id, p)
  return [...map.values()]
}
