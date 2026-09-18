/**
 * 轨迹解析器（计划案 3.2「轨迹层」/ 3.3 过程维度的数据基础）。
 *
 * 输入是 FileSessionStore 落盘的 JSONL 事件流，输出是**结构化工具轨迹**。
 * 之所以必须从落盘文件而非 stdout 解析：`run --json` 只回传 steps/content/
 * finishedReason 三个聚合值，无法支撑「过程质量」判定——例如是否空转重试、
 * 是否触碰禁区、是否在失败后仍宣称完成。
 *
 * 事件契约（packages/agent/src/index.ts）：
 * - `user|agent`      { content, attachments }
 * - `assistant|llm`   { content, toolCalls: [{ id, name, arguments(JSON 字符串) }], thinking }
 * - `tool|agent`      { callId, name, args, result: { text } | { error } }
 * - `subagent|agent`  同 tool（跨代理调用必须可审计）
 * - `error|agent`     { reason }
 * - `system|agent`    { goalVerify: { failed, attempt, detail } } 等
 */

/** 工具名 → 能力类别。用于「是否真的动手改代码」这类过程判定。 */
const TOOL_CLASSES = [
  { re: /^(read_file|read|view|cat)$/i, cls: 'read' },
  { re: /^(write_file|write|create_file|apply_patch|edit_file|replace_in_file|str_replace)$/i, cls: 'write' },
  { re: /^(list_dir|ls|glob|find_files)$/i, cls: 'search' },
  { re: /^(grep|search|ripgrep|search_code)$/i, cls: 'search' },
  { re: /^(run_command|bash|shell|exec|powershell)$/i, cls: 'exec' },
  { re: /^(run_tests?|test)$/i, cls: 'test' },
  { re: /^(delegate|spawn_agent|task|subagent)$/i, cls: 'delegate' },
  { re: /^(web_search|web_fetch|fetch)$/i, cls: 'network' },
  { re: /^(todo_write|todo)$/i, cls: 'plan' },
]

export function classifyTool(name) {
  for (const { re, cls } of TOOL_CLASSES) if (re.test(String(name))) return cls
  return 'other'
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : { __raw: raw }
  } catch {
    return { __raw: raw }
  }
}

/** 稳定化的调用指纹：同名同参即视为重复（用于空转检测）。 */
function callFingerprint(name, args) {
  let canonical
  try {
    canonical = JSON.stringify(args, Object.keys(args ?? {}).sort())
  } catch {
    canonical = String(args)
  }
  return `${name}::${canonical}`
}

function errorText(result) {
  if (!result || typeof result !== 'object') return null
  if (result.error === undefined) return null
  return typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
}

/**
 * 解析事件流为结构化轨迹。
 * @param {Array<object>} events 会话 JSONL 解析后的事件数组
 */
export function parseTrajectory(events) {
  const list = Array.isArray(events) ? events : []
  const messages = []
  const toolCalls = []
  const errors = []
  const goalVerifications = []
  const subagentCalls = []
  const notes = []

  /** 未闭合的 assistant tool_call：用于发现「宣告调用但无结果」的悬挂。 */
  const pending = new Map()

  for (const evt of list) {
    const type = evt?.type
    const payload = evt?.payload ?? {}
    const ts = typeof evt?.ts === 'number' ? evt.ts : null

    if (type === 'user') {
      messages.push({ role: 'user', ts, content: String(payload.content ?? '') })
      continue
    }

    if (type === 'assistant') {
      const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : []
      messages.push({
        role: 'assistant',
        ts,
        content: String(payload.content ?? ''),
        thinking: typeof payload.thinking === 'string' ? payload.thinking : null,
        toolCallIds: calls.map((c) => c?.id).filter(Boolean),
      })
      for (const c of calls) {
        if (!c?.id) continue
        pending.set(c.id, { name: c?.name ?? null, ts, index: toolCalls.length })
      }
      continue
    }

    if (type === 'tool' || type === 'subagent') {
      const name = String(payload.name ?? '')
      const args = parseArgs(payload.args)
      const err = errorText(payload.result)
      const record = {
        seq: toolCalls.length + 1,
        callId: payload.callId ?? null,
        name,
        cls: classifyTool(name),
        args,
        ok: err === null,
        error: err,
        resultDigest: null,
        ts,
        source: type === 'subagent' ? 'subagent' : 'tool',
      }
      if (payload.result && typeof payload.result.text === 'string') {
        record.resultChars = payload.result.text.length
        record.resultPreview = payload.result.text.slice(0, 400)
      }
      toolCalls.push(record)
      if (err !== null) errors.push({ kind: 'tool_error', name, message: err.slice(0, 400), ts })
      if (type === 'subagent') subagentCalls.push(record)
      if (record.callId) pending.delete(record.callId)
      continue
    }

    if (type === 'error') {
      errors.push({ kind: 'agent_error', name: null, message: String(payload.reason ?? ''), ts })
      continue
    }

    if (type === 'system') {
      if (payload.goalVerify) {
        goalVerifications.push({
          failed: Boolean(payload.goalVerify.failed),
          attempt: payload.goalVerify.attempt ?? null,
          detail: payload.goalVerify.detail ?? null,
          ts,
        })
      } else {
        notes.push({ ts, keys: Object.keys(payload) })
      }
    }
  }

  for (const [callId, info] of pending) {
    errors.push({
      kind: 'dangling_tool_call',
      name: info.name,
      message: `assistant 宣告了 tool_call 但未落盘任何结果（callId=${callId}）`,
      ts: info.ts,
    })
  }

  const assistantTurns = messages.filter((m) => m.role === 'assistant').length
  const toolHistogram = {}
  for (const c of toolCalls) toolHistogram[c.name] = (toolHistogram[c.name] ?? 0) + 1

  const classHistogram = {}
  for (const c of toolCalls) classHistogram[c.cls] = (classHistogram[c.cls] ?? 0) + 1

  const fingerprints = new Map()
  const repeats = []
  for (const c of toolCalls) {
    const fp = callFingerprint(c.name, c.args)
    const prev = fingerprints.get(fp)
    if (prev) {
      repeats.push({ name: c.name, seq: c.seq, firstSeq: prev, argsDigestable: Boolean(c.args) })
    } else {
      fingerprints.set(fp, c.seq)
    }
  }

  return {
    eventCount: list.length,
    messages,
    assistantTurns,
    toolCalls,
    subagentCalls,
    errors,
    goalVerifications,
    notes,
    counters: {
      toolCalls: toolCalls.length,
      distinctTools: Object.keys(toolHistogram).length,
      failedToolCalls: toolCalls.filter((c) => !c.ok).length,
      repeatedToolCalls: repeats.length,
      subagentCalls: subagentCalls.length,
      goalVerifyRuns: goalVerifications.length,
      goalVerifyFailures: goalVerifications.filter((g) => g.failed).length,
      danglingToolCalls: errors.filter((e) => e.kind === 'dangling_tool_call').length,
    },
    toolHistogram,
    classHistogram,
    repeats,
    firstTs: list.find((e) => typeof e?.ts === 'number')?.ts ?? null,
    lastTs: [...list].reverse().find((e) => typeof e?.ts === 'number')?.ts ?? null,
  }
}

/** 收敛率：重复调用占比。高重复率 = 空转，是「过程质量」的核心负向信号。 */
function repeatRatio(counters) {
  if (!counters.toolCalls) return 0
  return counters.repeatedToolCalls / counters.toolCalls
}

/**
 * 过程质量画像。
 *
 * `reportedSteps` 与 `networkCalls` 的对比是刻意设计的：Harness 自报的 steps
 * 通常只计「主循环轮次」，而网络层能看到它额外发起的校验/摘要/标题生成调用。
 * 两者之差即**未自报调用**，是成本透明度的直接证据。
 *
 * @param {ReturnType<typeof parseTrajectory>} traj
 * @param {{reportedSteps?: number|null, networkCalls?: number|null, wallMs?: number|null}} [ctx]
 */
export function profileProcess(traj, ctx = {}) {
  const c = traj.counters
  const reportedSteps = typeof ctx.reportedSteps === 'number' ? ctx.reportedSteps : null
  const networkCalls = typeof ctx.networkCalls === 'number' ? ctx.networkCalls : null

  const unreported =
    reportedSteps !== null && networkCalls !== null ? Math.max(0, networkCalls - reportedSteps) : null
  const unreportedRatio = unreported !== null && networkCalls > 0 ? unreported / networkCalls : null

  return {
    toolCallCount: c.toolCalls,
    distinctTools: c.distinctTools,
    failedToolCalls: c.failedToolCalls,
    repeatedToolCalls: c.repeatedToolCalls,
    repeatRatio: repeatRatio(c),
    subagentCalls: c.subagentCalls,
    goalVerifyRuns: c.goalVerifyRuns,
    goalVerifyFailures: c.goalVerifyFailures,
    danglingToolCalls: c.danglingToolCalls,
    assistantTurns: traj.assistantTurns,
    toolHistogram: traj.toolHistogram,
    classHistogram: traj.classHistogram,
    reportedSteps,
    networkCalls,
    unreportedCalls: unreported,
    unreportedRatio,
    /** 是否真的产生了写操作（增量交付的弱证据，最终以工作区 diff 为准）。 */
    performedWrites: (traj.classHistogram.write ?? 0) > 0 || (traj.classHistogram.exec ?? 0) > 0,
    ranTests: (traj.classHistogram.test ?? 0) > 0,
  }
}

/** 轨迹 → 纯文本渲染，用于报告与失败定位。 */
export function renderTrajectory(traj, { limit = 40 } = {}) {
  const lines = []
  let i = 0
  for (const m of traj.messages) {
    if (i >= limit) {
      lines.push(`…（省略 ${traj.messages.length - limit} 条消息）`)
      break
    }
    i += 1
    if (m.role === 'user') lines.push(`[用户] ${oneLine(m.content, 200)}`)
    else if (m.role === 'assistant') {
      lines.push(`[助手] ${oneLine(m.content, 200)}${m.toolCallIds.length ? ` → 调用 ${m.toolCallIds.join(', ')}` : ''}`)
    }
  }
  for (const t of traj.toolCalls.slice(0, limit)) {
    lines.push(`  · #${t.seq} ${t.name}(${oneLine(JSON.stringify(t.args), 120)}) ${t.ok ? '✓' : `✗ ${oneLine(t.error, 120)}`}`)
  }
  if (traj.toolCalls.length > limit) lines.push(`  …（省略 ${traj.toolCalls.length - limit} 次工具调用）`)
  return lines.join('\n')
}

function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
