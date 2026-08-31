import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  chunkText,
  extractText,
  FileKnowledgeStore,
  createKnowledgeBase,
  createRetriever,
  buildKnowledgePrompt,
} from '../src/index.js'

const root = dirname(fileURLToPath(import.meta.url))
const tmp = () => join(root, '..', `.test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)

describe('chunkText', () => {
  it('按目标长度切块且保留重叠', () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i}段内容，用于测试分块逻辑的正确性。`).join('\n\n')
    const chunks = chunkText(text, { size: 200, overlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(220)
  })

  it('空文本返回空数组', () => {
    expect(chunkText('  ')).toEqual([])
  })
})

describe('extractText', () => {
  it('提取文本类文件', () => {
    const buf = Buffer.from('hello 世界\n第二行', 'utf-8')
    expect(extractText('a.txt', buf)).toBe('hello 世界\n第二行')
    expect(extractText('a.md', buf)).toContain('hello')
  })

  it('不支持的格式返回空字符串', () => {
    expect(extractText('a.pdf', Buffer.from('%PDF-1.4'))).toBe('')
    expect(extractText('noext', Buffer.from('内容'))).toBe('')
  })
})

describe('FileKnowledgeStore + retriever', () => {
  it('入库、检索（关键词降级）、删除、清空', async () => {
    const dir = tmp()
    const store = new FileKnowledgeStore({ path: join(dir, 'index.json') })
    const doc = await store.addDocument({
      title: '电网调度规程',
      source: '电网调度规程.txt',
      scope: 'global',
      text: '电网调度应遵循统一调度、分级管理的原则。负荷预测是调度计划的基础。'.repeat(50),
      tags: ['电网'],
    })
    expect(doc.chunkCount).toBeGreaterThan(0)

    const retriever = createRetriever(store) // 无 embedding → 关键词降级
    const hits = await retriever.search({ q: '负荷预测', topK: 3 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].docTitle).toBe('电网调度规程')

    expect(await store.remove(doc.id)).toBe(true)
    expect((await store.list()).length).toBe(0)

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('createKnowledgeBase', () => {
  it('无 embedding 配置时降级可用', async () => {
    const dir = tmp()
    const kb = createKnowledgeBase({ path: join(dir, 'index.json'), scope: 'global' })
    expect(kb.hasEmbedding).toBe(false)
    await kb.store.addDocument({ title: '施工', source: 'x.txt', scope: 'global', text: '建筑施工现场安全管理要点。' })
    const enhanced = await kb.enhancer('base prompt', '施工安全')
    expect(enhanced).toContain('Knowledge Base Context')
    rmSync(dir, { recursive: true, force: true })
  })
})
