import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { SpecManager } from '../src/index.js'

/** 构造一个最小 zip 能力包字节。 */
function makeZip(manifest: Record<string, unknown>): Buffer {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'))
  zip.addFile('skills/build.yaml', Buffer.from('name: build\nversion: 1.0\ntemplate: 按建筑规范施工 {{input}}', 'utf-8'))
  zip.addFile('knowledge/guide.md', Buffer.from('# 建筑施工指南\n本手册面向专业施工人员。', 'utf-8'))
  return zip.toBuffer()
}

describe('SpecManager', () => {
  it('安装 zip → 落盘 + 注册表 + 技能目录；禁用/启用/移除', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-spec-'))
    try {
      const manager = new SpecManager({ dir })
      const manifest = {
        id: 'architecture',
        name: '建筑专业包',
        version: '1.2.0',
        description: '面向建筑行业',
        category: '建筑',
        icon: '🏗️',
      }
      const buf = makeZip(manifest)
      const { spec, contents } = await manager.install(buf)

      expect(spec.id).toBe('architecture')
      expect(spec.enabled).toBe(true)
      expect(spec.skillCount).toBe(1)
      expect(spec.knowledgeCount).toBe(1)
      expect(contents.skills[0].name).toBe('build.yaml')
      expect(contents.knowledge[0].name).toBe('guide.md')

      // 已落盘
      expect(existsSync(join(dir, 'architecture', 'manifest.json'))).toBe(true)
      expect(existsSync(join(dir, 'architecture', 'skills', 'build.yaml'))).toBe(true)
      expect(readFileSync(join(dir, 'architecture', 'knowledge', 'guide.md'), 'utf-8')).toContain('建筑施工')

      // 注册表查询
      const list = await manager.list()
      expect(list).toHaveLength(1)
      expect((await manager.get('architecture'))?.name).toBe('建筑专业包')
      expect(await manager.enabledIds()).toEqual(['architecture'])

      // 已启用包的技能目录
      expect(manager.enabledSkillDirs()).toEqual([join(dir, 'architecture', 'skills')])

      // 禁用 → 技能目录消失
      await manager.disable('architecture')
      expect(await manager.enabledIds()).toEqual([])
      expect(manager.enabledSkillDirs()).toEqual([])
      expect(await manager.disabledIds()).toEqual(['architecture'])

      // 重新启用
      await manager.enable('architecture')
      expect(await manager.enabledIds()).toEqual(['architecture'])

      // 移除
      expect(await manager.remove('architecture')).toBe(true)
      expect(await manager.list()).toEqual([])
      expect(existsSync(join(dir, 'architecture'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺少 manifest.json 时报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-spec-nomanifest-'))
    try {
      const manager = new SpecManager({ dir })
      const zip = new AdmZip()
      zip.addFile('skills/a.yaml', Buffer.from('name: a', 'utf-8'))
      await expect(manager.install(zip.toBuffer())).rejects.toThrow(/manifest\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法 id 时报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-spec-badid-'))
    try {
      const manager = new SpecManager({ dir })
      await expect(manager.install(makeZip({ id: 'bad id!', name: 'x' }))).rejects.toThrow(/manifest\.id/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('覆盖安装同一 id 时替换旧文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-spec-reinstall-'))
    try {
      const manager = new SpecManager({ dir })
      await manager.install(makeZip({ id: 'arch', name: 'v1' }))
      await manager.install(makeZip({ id: 'arch', name: 'v2', version: '2.0.0' }))
      const record = await manager.get('arch')
      expect(record?.name).toBe('v2')
      expect(record?.version).toBe('2.0.0')
      expect((await manager.list())).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
