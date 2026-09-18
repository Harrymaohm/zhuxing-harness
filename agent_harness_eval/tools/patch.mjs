import fs from 'node:fs'

const p = 'agent_harness_eval/src/probes.mjs'
let t = fs.readFileSync(p, 'utf8')
const before = t.length
const log = []

function sub(from, to) {
  if (!t.includes(from)) {
    log.push(`MISS(string): ${from.slice(0, 60)}`)
    return
  }
  t = t.replace(from, to)
  log.push(`OK: ${from.slice(0, 40)}`)
}

function subRe(re, to) {
  if (!re.test(t)) {
    log.push(`MISS(regex): ${String(re).slice(0, 60)}`)
    return
  }
  t = t.replace(re, to)
  log.push(`OK(regex): ${String(re).slice(0, 40)}`)
}

sub("  'lifecycle-maxsteps-cap': PROBES_PLACEHOLDER_RUNTIME_KILLSWITCH(),", "  'lifecycle-maxsteps-cap': killswitchProbe,")
subRe(/ {2}'runtime-killswitch': async \(c, env\) => \{[\s\S]*?\n {2}\},\n/, "  'runtime-killswitch': killswitchProbe,\n")

const killImpl = [
  '/** 步数上限探针（运行时安全 + 生命周期边界共用同一实现）。 */',
  'async function killswitchProbe(c, env) {',
  '  const r = await rig(env, env.paths, {',
  '    tag: `kill-${c.id}`,',
  '    maxSteps: 4,',
  "    plan: { '*': [{ content: '继续。', toolCalls: [{ name: 'read_file', arguments: { path: 'notes.md' } }] }] },",
  '  })',
  "  const res = await r.agent.run('无休止任务')",
  '  const e = await evid(env, r)',
  '  const facts = { steps: res.steps, finishedReason: res.finishedReason, effects: r.effects.length }',
  "  return res.finishedReason === 'max-steps' && res.steps <= 4",
  '    ? okResult(`步数上限终止生效（steps=${res.steps}）`, facts, e)',
  "    : failResult(`步数上限未生效（steps=${res.steps}, reason=${res.finishedReason}）`, facts, e, 'P1')",
  '}',
].join('\n')

subRe(
  /function PROBES_PLACEHOLDER_RUNTIME_KILLSWITCH\(\) \{[\s\S]*?async function PROBES_IMPL_killswitch\(c, env\) \{[\s\S]*?\n\}/,
  killImpl,
)

sub(
  "app.on?.('tools/before-exec', (p) => (p?.name === 'write_file' ? false : undefined))",
  "app.events.on('tools/before-exec', (p) => (p?.name === 'write_file' ? false : undefined))",
)

const from = [
  "    const on = typeof app.on === 'function' ? app.on.bind(app) : undefined",
  "    if (!on) return unprovenResult('Harness 未暴露事件订阅面，无法观测插件生命周期', {}, { trajectory: true })",
  "    for (const name of ['plugin/mount', 'plugin/unmount', 'plugin/mounted', 'plugin/unmounted']) on(name, (p) => events.push({ name, p }))",
].join('\n')
const to = [
  '    const bus = app.events',
  "    if (!bus || typeof bus.on !== 'function') return unprovenResult('Harness 未暴露事件订阅面，无法观测插件生命周期', {}, { trajectory: true })",
  "    for (const name of ['plugin/mounted', 'plugin/unmounted']) bus.on(name, (p) => events.push({ name, p }))",
].join('\n')
sub(from, to)

fs.writeFileSync(p, t)
console.log('bytes', before, '->', t.length)
console.log(log.join('\n'))
