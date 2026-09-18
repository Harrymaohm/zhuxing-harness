import fs from 'node:fs'
const t = fs.readFileSync('agent_harness_eval/src/scenarios.mjs', 'utf8').split('\n')
t.forEach((l, i) => {
  if (/(\bid:|\bprobe:|\bplanId:|\bkind:|^export |\bboundary:)/.test(l)) console.log(`${i + 1}: ${l.trim().slice(0, 130)}`)
})
console.log('--- lines', t.length)
