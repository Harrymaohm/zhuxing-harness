import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyZipToRoot } from '../src/updater.js'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhuxing-updater-'))
  writeFileSync(join(root, 'VERSION'), '1.0.0\n', 'utf-8')
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'harness.cjs'), '// cli\n', 'utf-8')
  return root
}

/**
 * 构造增量包。注意：AdmZip 的 addFile 会对条目名做 zipnamefix（剥离 `../` 与前导 `/`），
 * 因此要造出真实的越界条目，必须在 addFile 之后直接改写 entryName —— 否则根本测不到 zip-slip 防护。
 */
function makeZip(name: string, entries: Array<{ add: string; raw?: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zhuxing-zip-'))
  const zipPath = join(dir, name)
  const zip = new AdmZip()
  for (const e of entries) {
    zip.addFile(e.add, Buffer.from(e.content, 'utf-8'))
    if (e.raw) {
      const entry = zip.getEntries().find((x) => x.entryName === e.add)
      if (!entry) throw new Error(`构造测试包失败：找不到条目 ${e.add}`)
      entry.entryName = e.raw
    }
  }
  zip.writeZip(zipPath)
  return zipPath
}

describe('增量包 zip-slip 防护（applyZipToRoot）', () => {
  it('含 ../ 越界条目的包被整体拒绝，且不产生任何副作用', () => {
    const root = makeRoot()
    const escaped = join(root, '..', 'zhuxing-escaped.txt')
    const zipPath = makeZip('evil.zip', [
      { add: 'bin/harness.cjs', content: '// cli v2\n' },
      { add: 'escaped.txt', raw: '../zhuxing-escaped.txt', content: 'pwned' },
    ])

    const res = applyZipToRoot(zipPath, root)

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('越界路径')
    // 校验先于一切副作用：越界文件没落盘、未备份、未覆盖
    expect(existsSync(escaped)).toBe(false)
    expect(existsSync(join(root, 'backups'))).toBe(false)
    expect(readFileSync(join(root, 'bin', 'harness.cjs'), 'utf-8')).toBe('// cli\n')
    expect(readFileSync(join(root, 'VERSION'), 'utf-8').trim()).toBe('1.0.0')
  })

  it('深层层级逃逸（a/b/../../../x.txt）同样被拒绝', () => {
    const root = makeRoot()
    const zipPath = makeZip('evil-deep.zip', [
      { add: 'bin/harness.cjs', content: '// cli\n' },
      { add: 'deep.txt', raw: 'a/b/../../../zhuxing-deep-escaped.txt', content: 'pwned' },
    ])

    const res = applyZipToRoot(zipPath, root)

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('越界路径')
    expect(existsSync(join(root, '..', 'zhuxing-deep-escaped.txt'))).toBe(false)
  })

  it('绝对路径条目被拒绝', () => {
    const root = makeRoot()
    const zipPath = makeZip('evil-abs.zip', [
      { add: 'bin/harness.cjs', content: '// cli\n' },
      { add: 'abs.txt', raw: '/zhuxing-absolute-escaped.txt', content: 'pwned' },
    ])

    const res = applyZipToRoot(zipPath, root)

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('越界路径')
  })

  it('回归：缺少 bin/harness.cjs 的包仍按原逻辑拒绝', () => {
    const root = makeRoot()
    const zipPath = makeZip('no-cli.zip', [{ add: 'README.md', content: 'hi' }])

    const res = applyZipToRoot(zipPath, root)

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('bin/harness.cjs')
  })
})
