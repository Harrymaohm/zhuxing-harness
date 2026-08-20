import { mkdtempSync } from 'node:fs'
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
