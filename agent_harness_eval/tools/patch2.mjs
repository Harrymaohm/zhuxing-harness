import fs from 'node:fs'

const p = 'agent_harness_eval/src/probes.mjs'
let t = fs.readFileSync(p, 'utf8')
const log = []
function sub(from, to) {
  if (!t.includes(from)) return log.push(`MISS: ${from.slice(0, 70)}`)
  t = t.replace(from, to)
  log.push(`OK: ${from.slice(0, 50)}`)
}

// SessionImpl.append(type, source, payload) —— 位置参数
sub("await r.session.append({ type: 'user', source: 'eval', payload: { content: 'first' } })", "await r.session.append('user', 'eval', { content: 'first' })")
sub("await r.session.append({ type: 'user', source: 'eval', payload: { content: 'second' } })", "await r.session.append('user', 'eval', { content: 'second' })")
sub("await r.session.append({ type: 'user', source: 'eval', payload: { content: 'base' } })", "await r.session.append('user', 'eval', { content: 'base' })")

// append-only：事件级不可变（remove(sessionId) 是会话级能力，单列）
const oldBlock = [
  "    const mutators = ['update', 'delete', 'remove', 'patch', 'overwrite'].filter((m) => typeof r.store[m] === 'function')",
  "    const facts = { prefixStable, lines: t2.split('\\n').filter(Boolean).length, mutatorMethods: mutators }",
  '    const e = await evid(env, r, { policy: false })',
  '    return prefixStable && mutators.length === 0',
  "      ? okResult('JSONL 追加式写入：历史前缀不可变且无事件改写 API', facts, e)",
  "      : failResult(`追加式不成立：prefixStable=${prefixStable}, mutators=${mutators.join(',')}`, facts, e, 'P0')",
].join('\n')
const newBlock = [
  "    const eventMutators = ['update', 'patch', 'overwrite', 'updateEvent', 'rewrite', 'truncate'].filter((m) => typeof r.store[m] === 'function')",
  "    const sessionLevelOps = ['remove', 'rename', 'archiveSession'].filter((m) => typeof r.store[m] === 'function')",
  "    const facts = { prefixStable, lines: t2.split('\\n').filter(Boolean).length, eventMutators, sessionLevelOps }",
  '    const e = await evid(env, r, { policy: false })',
  '    return prefixStable && eventMutators.length === 0',
  "      ? okResult('JSONL 追加式写入：历史前缀逐字节不变且不存在事件改写 API（会话级 remove 属另一粒度，见 facts）', facts, e)",
  "      : failResult(`追加式不成立：prefixStable=${prefixStable}, eventMutators=${eventMutators.join(',')}`, facts, e, 'P0')",
].join('\n')
sub(oldBlock, newBlock)

fs.writeFileSync(p, t)
console.log(log.join('\n'))
