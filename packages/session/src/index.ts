import { randomUUID } from 'node:crypto'
import { FileSessionStore } from './file-store.js'

export type SessionEventType = 'system' | 'user' | 'assistant' | 'tool' | 'subagent' | 'error'

/** 追加式会话事件：模型可见的一切输入必须落为该事件（Model-visible means logged）。 */
export interface SessionEvent {
  id: string
  sessionId: string
  ts: number
  type: SessionEventType
  /** 来源插件 / 模块名。 */
  source: string
  payload: unknown
}

/** 会话存储抽象（可插拔持久化后端）。 */
export interface SessionStore {
  append(evt: SessionEvent): Promise<void>
  list(sessionId: string): Promise<SessionEvent[]>
  createSession(): Promise<string>
  /** fork：复制历史到新会话并返回新会话 id。 */
  forkSession(sourceId: string): Promise<string>
  remove(sessionId: string): Promise<void>
}

/** 会话句柄：只对单个会话操作。 */
export interface Session {
  readonly id: string
  append(type: SessionEventType, source: string, payload: unknown): Promise<SessionEvent>
  events(): Promise<SessionEvent[]>
  /** 派生一个继承历史的分叉会话。 */
  fork(): Promise<Session>
}

/** 内存会话存储（默认实现，可被持久化插件替换）。 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionEvent[]>()

  constructor(
    /** 每会话事件上限（超出修剪最旧事件）。默认不限制，保持 append-only 铁律。 */
    private maxEventsPerSession?: number,
  ) {}

  async append(evt: SessionEvent): Promise<void> {
    const list = this.sessions.get(evt.sessionId)
    if (list) {
      list.push(evt)
      if (this.maxEventsPerSession && list.length > this.maxEventsPerSession) {
        const overflow = list.length - this.maxEventsPerSession
        list.splice(0, overflow)
      }
    }
  }

  async list(sessionId: string): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId) ?? [])]
  }

  async createSession(): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, [])
    return id
  }

  async forkSession(sourceId: string): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, [...(this.sessions.get(sourceId) ?? [])].map((e) => ({ ...e })))
    return id
  }

  async remove(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }

  listAll(): string[] {
    return [...this.sessions.keys()]
  }
}

export class SessionImpl implements Session {
  constructor(
    private store: SessionStore,
    readonly id: string,
  ) {}

  async append(type: SessionEventType, source: string, payload: unknown): Promise<SessionEvent> {
    const evt: SessionEvent = {
      id: randomUUID(),
      sessionId: this.id,
      ts: Date.now(),
      type,
      source,
      payload,
    }
    await this.store.append(evt)
    return evt
  }

  events(): Promise<SessionEvent[]> {
    return this.store.list(this.id)
  }

  async fork(): Promise<Session> {
    const newId = await this.store.forkSession(this.id)
    return new SessionImpl(this.store, newId)
  }
}

/** 会话服务（ctx.session）：负责创建 / 获取会话。 */
export interface SessionService {
  create(): Promise<Session>
  get(sessionId: string): Promise<Session>
  listAll(): string[]
  /** 跨进程可用的会话清单（文件存储时有效）。 */
  listSessions(): Promise<string[]>
}

export class DefaultSessionService implements SessionService {
  constructor(private store: SessionStore) {}

  async create(): Promise<Session> {
    const id = await this.store.createSession()
    return new SessionImpl(this.store, id)
  }

  async get(sessionId: string): Promise<Session> {
    return new SessionImpl(this.store, sessionId)
  }

  listAll(): string[] {
    if (this.store instanceof MemorySessionStore) return this.store.listAll()
    return []
  }

  async listSessions(): Promise<string[]> {
    if (this.store instanceof FileSessionStore) return this.store.listSessions()
    return this.listAll()
  }
}

export { FileSessionStore }
