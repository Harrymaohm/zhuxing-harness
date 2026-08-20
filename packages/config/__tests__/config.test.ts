import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatch, loadPluginModule, resolvePlugins } from '../src/index.js'
import type { PluginConfig } from '../src/index.js'

function tempYaml(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('配置分层解析', () => {
  it('applyPatch：insert 同 id 覆盖 / replace / remove', () => {
    const base: PluginConfig[] = [
      { id: 'a', path: 'a.ts' },
      { id: 'b', path: 'b.ts' },
    ]
    const patched = applyPatch(base, [
      { op: 'insert', plugin: { id: 'a', path: 'a2.ts' } }, // 覆盖
      { op: 'insert', plugin: { id: 'c', path: 'c.ts' } }, // 新增
      { op: 'remove', id: 'b' }, // 删除
    ])
    expect(patched.map((p) => p.id)).toEqual(['a', 'c'])
    expect(patched[0].path).toBe('a2.ts')
  })

  it('resolvePlugins：profile → bundle → patch 合并', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhuxing-test-'))
    const bundleA = tempYaml(
      dir,
      'bundle-a.yml',
      `plugins:
  - id: alpha
    path: ./alpha.ts
  - id: beta
    path: ./beta.ts
`,
    )
    const bundleB = tempYaml(
      dir,
      'bundle-b.yml',
      `plugins:
  - id: gamma
    path: ./gamma.ts
`,
    )
    const profile = tempYaml(
      dir,
      'profile.yml',
      `name: test-profile
bundles:
  - ${bundleA.replace(/\\/g, '/')}
  - ${bundleB.replace(/\\/g, '/')}
patch:
  - op: replace
    id: alpha
    plugin:
      id: alpha
      path: ./alpha-patched.ts
  - op: remove
    id: beta
`,
    )
    const { plugins, sources } = await resolvePlugins({ profile, cwd: dir })
    expect(plugins.map((p) => p.id)).toEqual(['alpha', 'gamma'])
    // 相对路径已按 profile 所在目录归一化为绝对路径
    expect(plugins[0].path).toBe(join(dir, 'alpha-patched.ts'))
    expect(sources.length).toBe(3)
  })

  it('loadPluginModule 加载 TS 插件模块', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhuxing-test-'))
    const plugin = tempYaml(
      dir,
      'index.ts',
      `export const name = 'inline-ts-plugin'
export const inject = ['tools']
export function apply(ctx: any) {
  ctx.logger.info('hi')
}
`,
    )
    const mod = await loadPluginModule(plugin)
    expect((mod as { name: string }).name).toBe('inline-ts-plugin')
    expect(typeof (mod as { apply: unknown }).apply).toBe('function')
  })
})
