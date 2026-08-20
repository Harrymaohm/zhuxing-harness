import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginModule } from '../src/index.js'

describe('插件转译内容哈希缓存', () => {
  it('相同内容复用产物；修改内容生成新产物', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhuxing-cache-'))
    const src = join(dir, 'plug.ts')
    writeFileSync(src, `export const name = 'plug'\nexport function apply() {}\n`)

    const mod1 = await loadPluginModule(src)
    expect((mod1 as { name: string }).name).toBe('plug')
    const files1 = readdirSync(join(dir, '.harness-cache'))
    expect(files1).toHaveLength(1)

    // 内容未变：缓存命中，产物不新增
    const mod2 = await loadPluginModule(src)
    expect((mod2 as { name: string }).name).toBe('plug')
    expect(readdirSync(join(dir, '.harness-cache'))).toHaveLength(1)

    // 内容变化：生成新哈希产物
    writeFileSync(src, `export const name = 'plug'\nexport function apply() { console.log('v2') }\n`)
    await loadPluginModule(src)
    const files2 = readdirSync(join(dir, '.harness-cache'))
    expect(files2).toHaveLength(2)
  })

  it('并发加载同一文件不重复构建（锁）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhuxing-cache-'))
    const src = join(dir, 'conc.ts')
    writeFileSync(src, `export const name = 'conc'\nexport function apply() {}\n`)
    const [a, b] = await Promise.all([loadPluginModule(src), loadPluginModule(src)])
    expect((a as { name: string }).name).toBe('conc')
    expect((b as { name: string }).name).toBe('conc')
    expect(readdirSync(join(dir, '.harness-cache'))).toHaveLength(1)
  })
})
