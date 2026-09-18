import type { ServerResponse } from 'node:http'
import { maskSecrets } from '@zhuxing/harness-kernel'
import type { RuntimeManager } from './runtime.js'
import { json, sse, sseEnd } from './http.js'

/**
 * 在跑的 Agent 轮次登记表：runId → 取消控制器。
 *
 * 为什么需要它：AgentLoop 支持协作式取消（每个 step 前检查、并透传给模型请求），
 * 但「停止」按钮此前只是断开浏览器这一端的连接——服务端会把这一轮跑完，
 * 既白烧 token，也让运行时占用计数迟迟不归零（连带推迟配置变更与内核热重载）。
 * 这里让客户端用一个自生成的 runId 登记，停止时按 runId 精确取消。
 */
const activeRuns = new Map<string, { ac: AbortController; sessionId: string }>()

/**
 * 思考预算：推理模型的思考（reasoning_content）会整轮累积后展示为「临时说明」，
 * 实测单步可达上万字、整轮可达二十万字——界面会被这种量级撑爆，用户也读不下去。
 * 超过预算的部分不再下发（会话日志里仍留全量，可回看），只补一条「已省略」说明。
 */
const THINKING_STEP_BUDGET = 3000
const THINKING_RUN_BUDGET = 30_000

function registerRun(runId: string, ac: AbortController, sessionId: string): void {
  activeRuns.set(runId, { ac, sessionId })
}

function unregisterRun(runId: string, ac: AbortController): void {
  if (activeRuns.get(runId)?.ac === ac) activeRuns.delete(runId)
}

export function stopRun(runId: string): boolean {
  const entry = activeRuns.get(runId)
  if (!entry) return false
  entry.ac.abort()
  return true
}

/** 当前在跑的轮次（含所属会话）：界面刷新后靠它把「停止」重新挂回去。 */
export function listActiveRuns(): Array<{ runId: string; sessionId: string }> {
  return [...activeRuns.entries()].map(([runId, v]) => ({ runId, sessionId: v.sessionId }))
}

export async function handleChat(
  res: ServerResponse,
  message: string,
  sessionId: string | undefined,
  runtime: RuntimeManager,
  attachments?: Array<{ type: 'image'; dataUrl: string }>,
  spaceId?: string,
  contextSessionId?: string,
  runId?: string,
): Promise<void> {
  if (!message.trim() && !attachments?.length) {
    json(res, 400, { error: '消息不能为空' })
    return
  }

  // SSE 响应
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  let clientClosed = false
  const send = (event: string, data: unknown) => {
    if (!clientClosed) sse(res, event, data)
  }

  res.once('close', () => {
    clientClosed = true
  })

  // SSE 心跳：思考型模型可能几十秒不吐一个字，中间层（系统代理、安全软件、休眠唤醒）
  // 会把长时间静默的连接掐掉，表现就是对话停在半途再也不动。
  // 注释行不会触发客户端的任何事件处理，只负责保活。
  const heartbeat = setInterval(() => {
    if (clientClosed) return
    try {
      res.write(': ping\n\n')
    } catch {
      clientClosed = true
    }
  }, 15_000)

  // 占用运行时：直到本次流式对话结束才释放。期间若触发重建会先挂起，而不会 dispose 掉当前正在输出的实例，
  // 避免「进行中的对话突然失联」。并发请求（如另一次会话/配置变更）也会在 acquire 处等待重建完成。
  await runtime.acquire()
  try {
    // 热更新：每次指令前检查内核文件/版本是否变化，是则无重启换上新内核代码
    try {
      await runtime.maybeReload()
    } catch (err) {
      send('error', { message: maskSecrets(err instanceof Error ? err.message : String(err)) })
      return
    }

    const r = runtime.get()
    const app = r.app

    // 思考预算状态（本轮请求独占）：单步与整轮各设上限，超出部分不下发
    let thinkUsedInStep = 0
    let thinkUsedInRun = 0
    let thinkDroppedInStep = 0
    /** 本步收尾：把省略量补成一条说明，并重置单步计数（每步开头与整轮结束时各调一次）。 */
    function flushThinkingBudget(): void {
      if (thinkDroppedInStep > 0) {
        send('thinking', { text: `…（思考过长，本步已省略 ${thinkDroppedInStep} 字）` })
      }
      thinkUsedInStep = 0
      thinkDroppedInStep = 0
    }

    // 请求级订阅：结束时精确解绑，不泄漏到常驻运行时
    const unsubs: Array<() => void> = []
    // 本轮前置创建的会话 id（复用旧会话时为空）：结束时若一条事件都没写
    // （如精炼阶段就被停止），删掉空壳，不留垃圾记录。
    let preCreatedSessionId = ''
    unsubs.push(
      app.events.on(
        'agent/pre-step',
        (p: { step: number }) => {
          flushThinkingBudget()
          send('step', { step: (p.step as number) + 1 })
        },
        'web',
      ),
      // 指令精炼结果：让界面在开跑前就展示「把口语指令改写成了什么任务书」
      app.events.on(
        'agent/refined',
        (p: { instruction: string }) => send('brief', { instruction: p.instruction }),
        'web',
      ),
      app.events.on('tools/before-exec', (p: { name: string; args: Record<string, unknown> }) => send('tool', { name: p.name, args: p.args }), 'web'),
      app.events.on('tools/after-exec', (p: { name: string; result: unknown }) => send('tool_result', { name: p.name, result: p.result }), 'web'),
    )
    try {
      // 会话 id 前置：新会话在这里就把会话建出来，而不是等内核在 run 内部新建。
      // 登记时就能拿到真实会话 id——首条消息期间刷新，界面靠 /api/chat/active
      // 匹配到该轮并把「停止」补挂回去（此前登记的是空串，永远补不上）。
      let activeSessionId = await runtime.resolveSessionId(sessionId)
      if (!activeSessionId) {
        activeSessionId = await r.sessionStore.createSession()
        preCreatedSessionId = activeSessionId
        // 提前把会话归属告诉界面：新会话不必等到 result 才知道 id，
        // 刷新时 localStorage 里也已经有它，能恢复现场。
        send('session', { sessionId: activeSessionId })
      }
      // 登记本轮：客户端「停止」时按 runId 取消，服务端才真正停下（而非只断前端连接）
      const runAbort = new AbortController()
      if (runId) registerRun(runId, runAbort, activeSessionId)
      let result: Awaited<ReturnType<typeof r.agent.run>>
      try {
        result = await r.agent.run(message, activeSessionId, {
          onToken: (t) => send('token', { text: t }),
          // 思考按预算下发：单步超限即停发本步剩余、整轮超限即停发思考（会话日志仍留全量）
          onReasoning: (t) => {
            if (thinkUsedInRun >= THINKING_RUN_BUDGET) {
              thinkDroppedInStep += t.length
              return
            }
            const room = THINKING_STEP_BUDGET - thinkUsedInStep
            if (room <= 0) {
              thinkDroppedInStep += t.length
              return
            }
            const keep = t.length > room ? t.slice(0, room) : t
            thinkUsedInStep += keep.length
            thinkUsedInRun += keep.length
            thinkDroppedInStep += t.length - keep.length
            send('thinking', { text: keep })
          },
          attachments,
          contextSessionId,
          signal: runAbort.signal,
        })
      } finally {
        if (runId) unregisterRun(runId, runAbort)
      }
      // 末步收尾：把最后一步的省略量补成说明再发结果
      flushThinkingBudget()
      // 被「停止」取消时，AgentLoop 会把中断当成一次模型调用失败（finishedReason=error）报回来。
      // 那不是故障，是用户主动停的：对外统一成 aborted，避免把「我按了停止」渲染成一条红色错误。
      if (runAbort.signal.aborted) {
        send('result', { content: result.content, steps: result.steps, finishedReason: 'aborted', sessionId: result.sessionId })
        return
      }
      if (result.finishedReason === 'error') {
        send('error', {
          message: result.lastRaw ? maskSecrets(String(result.lastRaw)) : '模型调用失败，请检查 API Key / 网络 / 模型配置。',
        })
      }
      // 首次消息将新会话归属到指定空间（不覆盖已有归属）。
      if (spaceId && result.sessionId) {
        const store = runtime.get().sessionStore
        const meta = await store.getMeta(result.sessionId)
        if (!meta) {
          const now = Date.now()
          await store.setMeta({ id: result.sessionId, spaceId, createdAt: now, updatedAt: now })
        } else if (!meta.spaceId) {
          await store.setMeta({ ...meta, spaceId, updatedAt: Date.now() })
        }
      }
      send('result', {
        content: result.content,
        steps: result.steps,
        finishedReason: result.finishedReason,
        sessionId: result.sessionId,
      })
    } catch (err) {
      send('error', { message: maskSecrets(err instanceof Error ? err.message : String(err)) })
    } finally {
      for (const off of unsubs) off()
      // 前置创建的会话最终没落下任何事件（极端路径：精炼中被停止/内核抛错）：删除空壳。
      // 有事件的会话一律保留——「刷新恢复现场」与列表都依赖它。
      if (preCreatedSessionId) {
        try {
          const leftover = await r.sessionStore.list(preCreatedSessionId)
          if (leftover.length === 0) await r.sessionStore.remove(preCreatedSessionId)
        } catch {
          /* 清理失败不影响本轮收尾 */
        }
      }
    }
  } finally {
    clearInterval(heartbeat)
    sseEnd(res)
    runtime.release()
  }
}
