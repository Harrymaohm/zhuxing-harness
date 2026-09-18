import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultSkillDirs } from '@zhuxing/harness-bundle'
import { OpenAICompatibleProvider } from '@zhuxing/harness-llm'
import { FileSkillStore, validateSkillDefinition } from '@zhuxing/harness-skills'
import type { SkillDefinition } from '@zhuxing/harness-skills'
import { startWebServer } from '../src/server.js'
import type { WebServerHandle } from '../src/server.js'
import { buildSkillCandidates, reviewSkillCandidate } from '../src/skill-review.js'

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

  it('文件预览：工作区内可预览，工作区外默认拒绝', async () => {
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
    const previewBody = (await preview.json()) as { content: string }
    expect(previewBody.content).toContain('| 列 | 内容 |')

    // 默认受限级别（写操作限定工作区内）：工作区外文件不可预览
    const outsideFile = join(tmp, 'outside.md')
    writeFileSync(outsideFile, '外部文件内容', 'utf-8')
    const outside = await fetch(`${base()}/api/files/preview?path=${encodeURIComponent(outsideFile)}`)
    expect(outside.status).toBe(403)
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

  it('P0-1: SSE 首帧是 session 事件，进行中的轮次在 /api/chat/active 登记真实会话 id', async () => {
    // 挂起服务器：接受连接但永不回应——把这一轮钉在「等模型」的状态里，
    // 从而能在轮次进行中的窗口内观察：登记的应是真实会话 id，而非旧实现的空串。
    const stall = createServer()
    const sockets = new Set<Socket>()
    stall.on('connection', (s) => sockets.add(s))
    stall.on('request', () => {
      /* 故意不回应，吊住这一轮 */
    })
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r))
    const stallPort = (stall.address() as { port: number }).port
    try {
      await fetch(`${base()}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${stallPort}` }),
      })
      const res = await fetch(`${base()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi', sessionId: undefined, runId: 'run-p01-active' }),
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let head = ''
      for (let i = 0; i < 10 && !head.includes('event: session'); i++) {
        head += dec.decode((await reader.read()).value ?? new Uint8Array(), { stream: true })
      }
      // 会话事件先于模型调用下发（旧实现里新会话要等 result 才知道 id）
      expect(head).toContain('event: session')
      const frameSessionId = (
        JSON.parse(/event: session\ndata: (\{[^\n]*\})/.exec(head)![1]) as { sessionId: string }
      ).sessionId
      expect(frameSessionId).toBeTruthy()

      // 轮次进行中：active 应列出该 runId，且会话 id 与首帧一致
      let activeSessionId = ''
      for (let i = 0; i < 30 && !activeSessionId; i++) {
        const body = (await (await fetch(`${base()}/api/chat/active`)).json()) as {
          runs: Array<{ runId: string; sessionId: string }>
        }
        activeSessionId = body.runs.find((rr) => rr.runId === 'run-p01-active')?.sessionId ?? ''
        if (!activeSessionId) await new Promise((r) => setTimeout(r, 100))
      }
      expect(activeSessionId).toBe(frameSessionId)

      // 收尾：停止这一轮，再断开挂起连接；端口关闭后重试会立刻被拒，本轮快速结束
      const stop = (
        await (
          await fetch(`${base()}/api/chat/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: 'run-p01-active' }),
          })
        ).json()
      ) as { stopped: boolean }
      expect(stop.stopped).toBe(true)
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => stall.close(() => r()))

      // 本轮结束后从 active 除名
      let stillActive = true
      for (let i = 0; i < 50 && stillActive; i++) {
        const body = (await (await fetch(`${base()}/api/chat/active`)).json()) as {
          runs: Array<{ runId: string }>
        }
        stillActive = body.runs.some((rr) => rr.runId === 'run-p01-active')
        if (stillActive) await new Promise((r) => setTimeout(r, 100))
      }
      expect(stillActive).toBe(false)
      await reader.cancel()
    } finally {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => stall.close(() => r()))
    }
  }, 30_000)

  it('P0-1: 新会话对话结束后，前置创建的会话带内容出现在 /api/sessions', async () => {
    // 指向不可达端点快速收尾：精炼失败退回原话，user 事件仍会落盘（会话非空、不被当空壳清掉）
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
    const text = await res.text()
    expect(text).toContain('event: session')
    expect(text).toContain('event: error')
    const sid = (
      JSON.parse(/event: session\ndata: (\{[^\n]*\})/.exec(text)![1]) as { sessionId: string }
    ).sessionId
    const list = (await (await fetch(`${base()}/api/sessions`)).json()) as {
      sessions: Array<{ id: string }>
    }
    expect(list.sessions.some((s) => s.id === sid)).toBe(true)
  }, 30_000)

  it('P0-1: 零事件的空壳会话不进 /api/sessions 列表', async () => {
    const { FileSessionStore } = await import('@zhuxing/harness-session')
    const store = new FileSessionStore(process.env.HARNESS_SESSION_DIR ?? join(tmp, 'sessions'))
    const emptyId = await store.createSession()
    try {
      const list = (await (await fetch(`${base()}/api/sessions`)).json()) as {
        sessions: Array<{ id: string }>
      }
      expect(list.sessions.some((s) => s.id === emptyId)).toBe(false)
    } finally {
      await store.remove(emptyId)
    }
  })

  // ===== 技能上传：Agent Skills 规范的 SKILL.md =====

  /** 拼一份 SKILL.md：YAML frontmatter + 空行 + 正文。 */
  const skillMd = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n\n${body}\n`

  /** 打包一组 zip 条目（包内路径 → 文本），返回上传用的 base64。 */
  function zipBase64(entries: Record<string, string>): string {
    const zip = new AdmZip()
    for (const [path, content] of Object.entries(entries)) zip.addFile(path, Buffer.from(content, 'utf-8'))
    return zip.toBuffer().toString('base64')
  }

  const uploadFile = (name: string, content: string) => ({
    name,
    dataBase64: Buffer.from(content, 'utf-8').toString('base64'),
  })

  /** 目录条目（不存在视为空）：用于核对真实技能目录没被测试写入。 */
  const dirEntries = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

  describe('技能上传：SKILL.md', () => {
    it('单文件 .md：frontmatter 的 name/description + 正文即模板', async () => {
      const [c] = await buildSkillCandidates([
        uploadFile('pdf-extract.md', skillMd('name: pdf-extract\ndescription: 从 PDF 提取表格', '按以下要求提取表格。')),
      ])
      expect(c.sourceFile).toBe('pdf-extract.md')
      expect(c.issues).toEqual([])
      expect(c.skill?.name).toBe('pdf-extract')
      expect(c.skill?.description).toBe('从 PDF 提取表格')
      expect(c.skill?.template).toBe('按以下要求提取表格。')
    })

    it('单文件 .md：缺 name 时用文件名兜底；字面量 SKILL.md 不当名字；兜底名也非法则报错', async () => {
      const [byFileName] = await buildSkillCandidates([
        uploadFile('code-review.md', skillMd('description: 代码审查', '正文')),
      ])
      expect(byFileName.skill?.name).toBe('code-review')

      // frontmatter 自带 name 时以 frontmatter 为准，文件名 "SKILL.md" 永远不参与命名
      const [byFrontmatter] = await buildSkillCandidates([
        uploadFile('SKILL.md', skillMd('name: pdf-extract\ndescription: 提取表格', '正文')),
      ])
      expect(byFrontmatter.skill?.name).toBe('pdf-extract')

      // 文件名去扩展名后也不是合法技能名 → 候选 + 原因，不静默丢弃
      const [bothBad] = await buildSkillCandidates([
        uploadFile('非法 名.md', skillMd('description: 没有 name', '正文')),
      ])
      expect(bothBad.skill).toBeNull()
      expect(bothBad.issues.join()).toMatch(/name/)
      expect(bothBad.review.status).toBe('reject')
    })

    it('单文件 .md：缺 description / 无 frontmatter / 正文为空 → 候选 + 明确原因', async () => {
      const [noDesc] = await buildSkillCandidates([uploadFile('a.md', skillMd('name: a', '正文'))])
      expect(noDesc.skill).toBeNull()
      expect(noDesc.issues.join()).toMatch(/description/)

      const [noFrontmatter] = await buildSkillCandidates([uploadFile('b.md', '# 只有标题')])
      expect(noFrontmatter.skill).toBeNull()
      expect(noFrontmatter.issues.join()).toMatch(/frontmatter/)

      const [emptyBody] = await buildSkillCandidates([uploadFile('c.md', skillMd('name: c\ndescription: d', '   '))])
      expect(emptyBody.skill).toBeNull()
      expect(emptyBody.issues.join()).toMatch(/正文/)
    })

    it('zip：识别 <技能名>/SKILL.md（多级目录、多技能），非 SKILL.md 的 .md 忽略', async () => {
      const candidates = await buildSkillCandidates([
        {
          name: 'bundle.zip',
          dataBase64: zipBase64({
            'pdf-extract/SKILL.md': skillMd('description: 从 PDF 提取表格', '提取表格内容。'),
            'nested/deep/docx/SKILL.md': skillMd('name: docx\ndescription: 处理 docx', '读 docx。'),
            'plain-skill.yaml': 'name: plain-skill\ndescription: 自有 YAML 技能\ntemplate: 干活\n',
            'README.md': '# 不是技能\n',
          }),
        },
      ])
      const bySource = new Map(candidates.map((c) => [c.sourceFile, c]))
      expect([...bySource.keys()].sort()).toEqual([
        'nested/deep/docx/SKILL.md',
        'pdf-extract/SKILL.md',
        'plain-skill.yaml',
      ])
      expect(bySource.get('pdf-extract/SKILL.md')?.skill?.name).toBe('pdf-extract')
      expect(bySource.get('nested/deep/docx/SKILL.md')?.skill?.name).toBe('docx')
      expect(bySource.get('plain-skill.yaml')?.skill?.name).toBe('plain-skill')
      expect(candidates.every((c) => c.skill && c.issues.length === 0)).toBe(true)
    })

    it('zip：坏 SKILL.md 单独报错，不影响同包内其他技能', async () => {
      const candidates = await buildSkillCandidates([
        {
          name: 'mixed.zip',
          dataBase64: zipBase64({
            'good/SKILL.md': skillMd('description: 好技能', '正文'),
            'bad/SKILL.md': skillMd('name: bad', '正文'), // 缺 description
          }),
        },
      ])
      const bad = candidates.find((c) => c.sourceFile === 'bad/SKILL.md')
      const good = candidates.find((c) => c.sourceFile === 'good/SKILL.md')
      expect(bad?.skill).toBeNull()
      expect(bad?.issues.join()).toMatch(/description/)
      expect(bad?.review.status).toBe('reject')
      expect(good?.skill?.name).toBe('good')
    })

    it('zip 内既无 .yaml 也无 SKILL.md / 单文件格式不支持 → 文案点名 SKILL.md', async () => {
      const [empty] = await buildSkillCandidates([
        { name: 'x.zip', dataBase64: zipBase64({ 'docs/a.txt': 'x' }) },
      ])
      expect(empty.skill).toBeNull()
      expect(empty.issues.join()).toMatch(/SKILL\.md/)

      const [unsupported] = await buildSkillCandidates([uploadFile('a.txt', 'x')])
      expect(unsupported.skill).toBeNull()
      expect(unsupported.issues.join()).toMatch(/SKILL\.md/)
    })

    it('SKILL.md 候选与 YAML 候选走同一条审核路径', async () => {
      const [candidate] = await buildSkillCandidates([
        uploadFile('pdf-extract.md', skillMd('name: pdf-extract\ndescription: 提取表格', '正文')),
      ])
      // 未配置模型 → 审核函数给出「已跳过」，说明候选确实进了 reviewSkillCandidate
      const noModel = await reviewSkillCandidate(candidate, {})
      expect(noModel.review.status).toBe('skipped')
      expect(noModel.review.feedback).toMatch(/未配置模型/)

      // 配了模型但端点不可达 → 审核失败也不丢弃候选本身
      const unreachable = await reviewSkillCandidate(candidate, {
        apiKey: 'sk-test',
        model: 'test-m',
        baseUrl: 'http://127.0.0.1:9',
      })
      expect(unreachable.skill?.name).toBe('pdf-extract')
      expect(unreachable.review.status).toBe('skipped')
      expect(unreachable.review.feedback).toMatch(/AI 审核/)
    })

    it('审核模型回传的技能不含 source，也要保住 SKILL.md 来源（否则装回时又被判非法）', async () => {
      const [candidate] = await buildSkillCandidates([
        uploadFile('literal.md', skillMd('name: literal-md\ndescription: 正文含字面量占位符', '用法示例：{{foo}}')),
      ])
      expect(candidate.skill?.source?.format).toBe('skill-md')

      // 真实审核链路：模型只看到技能内容，回传的 JSON 里没有 source 这个字段
      const reviewedSkill = { ...candidate.skill!, source: undefined, template: '用法示例：{{foo}}（已规整）' }
      const chat = vi.spyOn(OpenAICompatibleProvider.prototype, 'chat').mockResolvedValue({
        content: JSON.stringify({ status: 'approve', feedback: '通过', issues: [], skill: reviewedSkill }),
        toolCalls: [],
        finishReason: 'stop',
      })
      try {
        const reviewed = await reviewSkillCandidate(candidate, {
          apiKey: 'sk-review-test',
          model: 'test-m',
          baseUrl: 'http://127.0.0.1:9',
        })
        expect(reviewed.review.status).toBe('approve')
        expect(reviewed.skill?.template).toBe('用法示例：{{foo}}（已规整）')
        // 来源由候选决定、不随模型输出丢失 → 校验不再把正文里的 {{foo}} 当模板笔误
        expect(reviewed.skill?.source?.format).toBe('skill-md')
        expect(reviewed.issues).toEqual([])
      } finally {
        chat.mockRestore()
      }
    })

    it('POST /api/skills/upload：含 SKILL.md 的 zip 被解析成候选（不是「格式不支持」）', async () => {
      // 审核指向不可达端点：快速失败，同时证明候选确实过了 AI 审核
      await fetch(`${base()}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-upload-test', model: 'test-m', baseUrl: 'http://127.0.0.1:9' }),
      })
      const res = await fetch(`${base()}/api/skills/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [
            {
              name: 'pdf-skill.zip',
              dataBase64: zipBase64({
                'pdf-extract/SKILL.md': skillMd('description: 从 PDF 提取表格', '提取表格内容。'),
              }),
            },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        candidates: Array<{
          sourceFile: string
          skill: { name: string; template: string } | null
          issues: string[]
          review: { status: string; feedback: string }
        }>
      }
      expect(body.candidates).toHaveLength(1)
      const c = body.candidates[0]
      expect(c.sourceFile).toBe('pdf-extract/SKILL.md')
      expect(c.skill).not.toBeNull()
      expect(c.skill?.name).toBe('pdf-extract')
      expect(c.skill?.template).toBe('提取表格内容。')
      expect(c.issues).toEqual([])
      expect(c.review.feedback).toMatch(/AI 审核/)
    }, 20_000)

    it('端到端：正文含 {{foo}} 的 SKILL.md 上传 → 安装成功（修复前 400「占位符未在 inputs.properties 定义」）', async () => {
      const name = 'literal-md-install'
      // 安装目标用临时目录（scope 传绝对路径即写入该目录），全程不碰真实的 ~/.zhuxing-harness/skills
      const tmpSkills = mkdtempSync(join(tmpdir(), 'zhuxing-skills-install-'))
      const realGlobalSkills = defaultSkillDirs()[0]
      const realEntriesBefore = dirEntries(realGlobalSkills)
      try {
        // 1. 上传：候选必须无问题（修复前的报错正是「占位符未定义」，安装会因此 400）
        const upload = await fetch(`${base()}/api/skills/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [
              uploadFile(
                'literal.md',
                skillMd(`name: ${name}\ndescription: 正文里的 {{foo}} 是字面量`, '用法示例：{{foo}}'),
              ),
            ],
            review: false,
          }),
        })
        expect(upload.status).toBe(200)
        const uploaded = (await upload.json()) as {
          candidates: Array<{ skill: SkillDefinition | null; issues: string[] }>
        }
        expect(uploaded.candidates).toHaveLength(1)
        expect(uploaded.candidates[0].issues).toEqual([])
        expect(uploaded.candidates[0].skill?.source?.format).toBe('skill-md')

        // 2. 安装：必须 200，而不是被校验拦成 400
        const install = await fetch(`${base()}/api/skills/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skill: uploaded.candidates[0].skill, scope: tmpSkills }),
        })
        expect(install.status).toBe(200)
        const installed = (await install.json()) as { skill: SkillDefinition; dir: string }
        expect(installed.dir).toBe(tmpSkills)
        // 3. 落盘形态可辨：按 Agent Skills 规范写成 <名称>/SKILL.md，不是伪装成自有 YAML 模板
        expect(installed.skill.source).toEqual({ format: 'skill-md', file: join(tmpSkills, name, 'SKILL.md') })
        expect(existsSync(join(tmpSkills, name, 'SKILL.md'))).toBe(true)
        expect(existsSync(join(tmpSkills, `${name}.yaml`))).toBe(false)

        // 4. 从磁盘读回再校验：仍是合法技能（否则会「装得上、此后一直显示非法」）
        const store = new FileSkillStore({ dirs: [tmpSkills] })
        const reloaded = await store.get(name)
        expect(reloaded?.source?.format).toBe('skill-md')
        expect(reloaded?.template).toBe('用法示例：{{foo}}')
        expect(validateSkillDefinition(reloaded!)).toEqual([])
      } finally {
        rmSync(tmpSkills, { recursive: true, force: true })
      }
      // 真实技能目录一条不多一条不少
      expect(dirEntries(realGlobalSkills)).toEqual(realEntriesBefore)
    })
  })
})
