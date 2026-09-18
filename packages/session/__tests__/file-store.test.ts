import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileSessionStore } from '../src/index.js'
import { DefaultSessionService, SessionImpl } from '../src/index.js'

describe('文件会话存储（JSONL 持久化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zhuxing-file-store-'))

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })

  it('create / append / list 往返', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 't', { x: 1 })
    await session.append('assistant', 't', { x: 2 })
    const events = await store.list(id)
    expect(events).toHaveLength(2)
    expect(events[0].payload).toEqual({ x: 1 })
  })

  it('fork 继承历史且独立', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    const session = new SessionImpl(store, id)
    await session.append('user', 't', { x: 1 })
    const fork = await session.fork()
    expect(fork.id).not.toBe(id)
    expect(await fork.events()).toHaveLength(1)
    await fork.append('user', 't', { x: 2 })
    expect(await session.events()).toHaveLength(1)
    expect(await fork.events()).toHaveLength(2)
  })

  it('listSessions / remove', async () => {
    const store = new FileSessionStore(dir)
    const id = await store.createSession()
    await store.append({ id: 'e1', sessionId: id, ts: Date.now(), type: 'user', source: 't', payload: {} })
    expect((await store.listSessions()).length).toBeGreaterThan(0)
    await store.remove(id)
    expect(await store.list(id)).toHaveLength(0)
  })

  it('SessionService.listSessions 委托文件存储', async () => {
    const store = new FileSessionStore(dir)
    const service = new DefaultSessionService(store)
    await service.create()
    const ids = await service.listSessions()
    expect(Array.isArray(ids)).toBe(true)
  })

  it('并发建空间/改名不丢更新（spaces.json 读改写必须串行）', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const raceDir = await mkdtemp(join(tmpdir(), 'zhuxing-spaces-race-'))
    try {
      const store = new FileSessionStore(raceDir)
      // 同一进程内 8 个并发创建：读改写不串行时，8 个调用各自读到同一份旧快照、
      // 再依次整文件覆盖，最终只剩最后一次写入（其余 7 个凭空消失）。
      const created = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createSpace(`空间 ${i + 1}`)))
      expect(new Set(created.map((s) => s.id)).size).toBe(8)

      const listed = await store.listSpaces()
      expect(listed).toHaveLength(8)
      expect(listed.map((s) => s.title).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `空间 ${i + 1}`).sort())

      // 改名与新建交错：改名必须基于「它排队时读到的那份快照」，不能被后写入的创建覆盖掉
      await Promise.all([store.renameSpace(created[0].id, '改过的名字'), store.createSpace('空间 9')])
      const after = await store.listSpaces()
      expect(after).toHaveLength(9)
      expect(after.find((s) => s.id === created[0].id)?.title).toBe('改过的名字')

      // 删除同样要走队列：与新建并发时，两者都不能吞掉对方
      await Promise.all([store.removeSpace(created[1].id), store.createSpace('空间 10')])
      const final = await store.listSpaces()
      expect(final).toHaveLength(9)
      expect(final.find((s) => s.id === created[1].id)).toBeUndefined()
      expect(final.some((s) => s.title === '空间 10')).toBe(true)
    } finally {
      await rm(raceDir, { recursive: true, force: true })
    }
  })

  it('JSONL 单行损坏只影响该行，其余历史照常可读', async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
    const d = await mkdtemp(join(tmpdir(), 'zhuxing-jsonl-broken-'))
    try {
      const store = new FileSessionStore(d)
      await store.append({ id: 'e1', sessionId: 's1', ts: 1, type: 'user', source: 't', payload: { a: 1 } })
      await store.append({ id: 'e2', sessionId: 's1', ts: 2, type: 'assistant', source: 't', payload: { a: 2 } })
      // 手工在中间插一行坏数据：此前一处解析失败会让整段历史静默变成空数组
      const file = join(d, 's1.jsonl')
      const lines = (await readFile(file, 'utf-8')).split('\n')
      await writeFile(file, `${lines[0]}\n{ 坏行\n${lines[1]}\n`, 'utf-8')

      const events = await store.list('s1')
      expect(events).toHaveLength(2)
      expect(events.map((e) => e.id)).toEqual(['e1', 'e2'])
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('元数据损坏时备份原文件，而不是静默当作「没有元数据」', async () => {
    const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/promises')
    const d = await mkdtemp(join(tmpdir(), 'zhuxing-meta-broken-'))
    try {
      const store = new FileSessionStore(d)
      await writeFile(join(d, 's2.meta.json'), '{ 坏掉的元数据', 'utf-8')
      expect(await store.getMeta('s2')).toBeUndefined()

      const backups = (await readdir(d)).filter((f) => f.startsWith('s2.meta.json.corrupt'))
      expect(backups).toHaveLength(1)
      expect(await readFile(join(d, backups[0]), 'utf-8')).toBe('{ 坏掉的元数据')
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('元数据带 BOM 属于「文件正常」，不该被误判为损坏', async () => {
    const { mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises')
    const d = await mkdtemp(join(tmpdir(), 'zhuxing-meta-bom-'))
    try {
      const store = new FileSessionStore(d)
      const meta = { id: 's3', title: '带 BOM 的标题', createdAt: 1, updatedAt: 1 }
      await writeFile(join(d, 's3.meta.json'), `\uFEFF${JSON.stringify(meta)}`, 'utf-8')

      expect((await store.getMeta('s3'))?.title).toBe('带 BOM 的标题')
      expect((await readdir(d)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0)
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('空间清单损坏时备份原文件，且后续新建不受污染', async () => {
    const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/promises')
    const d = await mkdtemp(join(tmpdir(), 'zhuxing-spaces-broken-'))
    try {
      const store = new FileSessionStore(d)
      await writeFile(join(d, 'spaces.json'), '[ 坏掉的空间', 'utf-8')
      expect(await store.listSpaces()).toEqual([])

      const backups = (await readdir(d)).filter((f) => f.startsWith('spaces.json.corrupt'))
      expect(backups).toHaveLength(1)
      expect(await readFile(join(d, backups[0]), 'utf-8')).toBe('[ 坏掉的空间')

      // 损坏内容已备份，新建应得到干净的清单而不是把坏数据带回来
      expect((await store.createSpace('新空间')).title).toBe('新空间')
      expect((await store.listSpaces()).map((s) => s.title)).toEqual(['新空间'])

      // 备份必须是有界的：`listSpaces` 每次都会读该文件，修复前若带时间戳，
      // 反复读取就会在目录里堆出一串备份
      expect((await readdir(d)).filter((f) => f.startsWith('spaces.json.corrupt'))).toHaveLength(1)
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })
})
