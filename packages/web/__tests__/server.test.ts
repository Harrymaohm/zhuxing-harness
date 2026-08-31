import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'
import type { WebServerHandle } from '../src/server.js'

describe('Web server API', () => {
  let handle: WebServerHandle
  const tmp = mkdtempSync(join(tmpdir(), 'zhuxing-web-'))
  const oldConfig = process.env.HARNESS_CONFIG
  const oldSessionDir = process.env.HARNESS_SESSION_DIR

  beforeAll(async () => {
    process.env.HARNESS_CONFIG = join(tmp, 'config.json')
    process.env.HARNESS_SESSION_DIR = join(tmp, 'sessions')
    handle = await startWebServer({ port: 0 })
  })

  afterAll(async () => {
    await new Promise<void>((r) => handle.server.close(() => r()))
    if (oldConfig === undefined) delete process.env.HARNESS_CONFIG
    else process.env.HARNESS_CONFIG = oldConfig
    if (oldSessionDir === undefined) delete process.env.HARNESS_SESSION_DIR
    else process.env.HARNESS_SESSION_DIR = oldSessionDir
  })

  const base = () => handle.url

  it('health 返回版本', async () => {
    const res = await fetch(`${base()}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/\d+\.\d+\.\d+/)
  })

  it('sessions 初始为空', async () => {
    const res = await fetch(`${base()}/api/sessions`)
    const body = (await res.json()) as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })

  it('config 保存与读取（apiKey 脱敏）', async () => {
    const save = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-abcdef1234567890', model: 'test-m' }),
    })
    expect(save.ok).toBe(true)
    const got = (await (await fetch(`${base()}/api/config`)).json()) as { model: string; apiKey: string }
    expect(got.model).toBe('test-m')
    expect(got.apiKey).toContain('***')
    expect(got.apiKey).not.toContain('abcdef123456')
  })

  it('子模型与生图模型配置保存（子模型 apiKey 脱敏且未提交时保留旧值）', async () => {
    // 1. 保存子模型（带 apiKey）与生图模型
    const save1 = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        models: [{ id: 'coder', model: 'deepseek-coder', capabilities: ['code'], apiKey: 'sk-subkey123456' }],
        imageModel: { model: 'wanx-v1', apiKey: 'sk-imgkey123456', size: '1024x1024' },
      }),
    })
    expect(save1.ok).toBe(true)

    // 2. GET 返回脱敏值
    const got1 = (await (await fetch(`${base()}/api/config`)).json()) as {
      models: Array<{ id: string; apiKey?: string }>
      imageModel?: { apiKey?: string }
    }
    expect(got1.models[0].apiKey).toContain('***')
    expect(got1.imageModel?.apiKey).toContain('***')

    // 3. 前端保存时 apiKey 置 undefined（模拟掩码不提交）→ 旧值保留
    const save2 = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        models: [{ id: 'coder', model: 'deepseek-coder', capabilities: ['code', 'fast'] }],
        imageModel: { model: 'wanx-v1', size: '512x512' },
      }),
    })
    expect(save2.ok).toBe(true)
    const got2 = (await (await fetch(`${base()}/api/config`)).json()) as {
      models: Array<{ id: string; capabilities: string[]; apiKey?: string }>
      imageModel?: { size?: string; apiKey?: string }
    }
    expect(got2.models[0].capabilities).toEqual(['code', 'fast'])
    expect(got2.models[0].apiKey).toContain('***') // 旧密钥仍在（脱敏显示）
    expect(got2.imageModel?.size).toBe('512x512')
    expect(got2.imageModel?.apiKey).toContain('***')
  })

  it('GET /api/models 返回配置的子模型', async () => {
    const res = await fetch(`${base()}/api/models`)
    const body = (await res.json()) as { models: Array<{ id: string }>; main: string }
    expect(body.models.map((m) => m.id)).toContain('coder')
    expect(body.main).toBe('test-m')
  })

  it('文件预览：工作区内可预览，danger-full-access 下允许任意文件', async () => {
    const workspace = join(tmp, 'workspace')
    const file = join(workspace, 'notes.md')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(file, '| 列 | 内容 |\n| --- | --- |\n| A | B |\n', 'utf-8')
    const save = await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    })
    expect(save.ok).toBe(true)

    const preview = await fetch(`${base()}/api/files/preview?path=${encodeURIComponent('notes.md')}`)
    expect(preview.status).toBe(200)
    expect((await preview.json()).content).toContain('| 列 | 内容 |')

    // 默认 danger-full-access：工作区外文件也可预览（文件链接/拖拽场景）
    const outsideFile = join(tmp, 'outside.md')
    writeFileSync(outsideFile, '外部文件内容', 'utf-8')
    const outside = await fetch(`${base()}/api/files/preview?path=${encodeURIComponent(outsideFile)}`)
    expect(outside.status).toBe(200)
    expect((await outside.json()).content).toContain('外部文件内容')
  })

  it('会话分叉与合并 API', async () => {
    const { FileSessionStore } = await import('@zhuxing/harness-session')
    const { SessionImpl } = await import('@zhuxing/harness-session')
    const store = new FileSessionStore(process.env.HARNESS_SESSION_DIR ?? join(tmp, 'sessions'))
    const parent = await store.createSession()
    const pSession = new SessionImpl(store, parent)
    await pSession.append('user', 't', { content: '父问题' })
    await pSession.append('assistant', 't', { content: '父回答' })

    // fork
    const forkRes = await fetch(`${base()}/api/sessions/${encodeURIComponent(parent)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(forkRes.ok).toBe(true)
    const childId = ((await forkRes.json()) as { sessionId: string }).sessionId
    const cSession = new SessionImpl(store, childId)
    await cSession.append('user', 't', { content: '子探索' })

    // merge
    const mergeRes = await fetch(`${base()}/api/sessions/${encodeURIComponent(parent)}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId, summary: '子对话结论' }),
    })
    expect(mergeRes.ok).toBe(true)

    const parentEvents = await store.list(parent)
    expect(parentEvents.some((e) => (e.payload as { content?: string }).content === '子对话结论')).toBe(true)

    // 列表带 parentId
    const list = (await (await fetch(`${base()}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; parentId?: string }>
    }
    expect(list.sessions.find((s) => s.id === childId)?.parentId).toBe(parent)
  })

  it('chat 空消息返回 400', async () => {
    const res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '  ' }),
    })
    expect(res.status).toBe(400)
  })

  it('chat SSE 流：模型不可达时收到 error 与 done', async () => {
    // 指向本地不可达端点 → 快速失败而非 120s 超时
    await fetch(`${base()}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }),
    })
    const res = await fetch(`${base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: undefined }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: error')
    expect(text).toContain('event: done')
  }, 20_000)
})
