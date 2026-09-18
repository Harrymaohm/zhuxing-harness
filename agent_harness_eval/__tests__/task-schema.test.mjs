/**
 * 任务语料 Schema 与加载器的单元测试。
 *
 * 语料是「被测物」的输入，它自己写错会让评测得出安静的错误结论。因此这里既测
 * 归一化的容错（snake_case 别名），也测加载期就必须暴露的硬错误（缺字段、id 重复、
 * fixture 目录写错），并顺带守住真实语料目录的完整性与纯度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { REPO_ROOT, EVAL_ROOT } from '../src/cli-adapter.mjs'
import { TASK_TYPES, loadTasks, normalizeTask } from '../src/task-schema.mjs'

const BASE = {
  id: 'sample-task',
  taskType: 'bug_fix',
  task: '修好它',
  repository: { mode: 'fixture', fixture: './fixtures/sample' },
  verification: { runner: 'tap', command: 'node --test --test-reporter=tap x.test.mjs', failToPass: ['用例 A'], passToPass: [] },
  constraints: { maxSteps: 8, maxWallMs: 60_000, allowedPaths: ['x.mjs'] },
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-schema-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('normalizeTask：接受 snake_case 别名并统一归一为 camelCase', () => {
  const { task, errors } = normalizeTask(
    {
      id: 'alias-task',
      task_type: 'failure_recovery',
      task: '顶住故障把活干完',
      repository: { mode: 'fixture', fixture: './fixtures/x', setup_commands: ['node -v'] },
      verification: { command: 'node --test x.test.mjs', fail_to_pass: ['A'], pass_to_pass: ['B'] },
      constraints: { max_steps: 7, max_wall_ms: 30_000, max_token_budget: 5000, allowed_paths: ['a.mjs'], forbidden_commands: ['rm '] },
      allowsDelegation: true,
    },
    { dir: 'E:/eval/tasks', repoRoot: 'E:/eval', file: 'E:/eval/tasks/alias-task.json' },
  )

  assert.deepEqual(errors, [])
  assert.equal(task.taskType, 'failure_recovery')
  assert.equal(task.verification.failToPass.length, 1)
  assert.equal(task.verification.passToPass[0], 'B')
  assert.equal(task.constraints.maxSteps, 7)
  assert.equal(task.constraints.maxTokenBudget, 5000)
  // 数组元素会被 trim，语料里的 'rm ' 与 'rm' 等价
  assert.deepEqual(task.constraints.forbiddenCommands, ['rm'])
  assert.deepEqual(task.repository.setupCommands, ['node -v'])
  assert.equal(task.allowsDelegation, true)
})

test('normalizeTask：fixture 路径相对任务文件解析（跟着语料走，不跟 cwd 走）', () => {
  const { task } = normalizeTask(BASE, { dir: 'E:/eval/tasks', repoRoot: 'E:/eval', file: 'E:/eval/tasks/sample-task.json' })
  assert.equal(task.repository.fixture, resolve('E:/eval/tasks/fixtures/sample'))

  const absolute = resolve('E:/elsewhere/fixture')
  const { task: task2 } = normalizeTask(
    { ...BASE, repository: { mode: 'fixture', fixture: absolute } },
    { dir: 'E:/eval/tasks', repoRoot: 'E:/eval', file: 'E:/eval/tasks/sample-task.json' },
  )
  assert.equal(task2.repository.fixture, absolute)
})

test('normalizeTask：语料自身的错误必须在加载期一次性报出', () => {
  const bad = {
    id: 'Bad_ID',
    taskType: 'unknown_type',
    task: '',
    repository: { mode: 'docker', fixture: '' },
    verification: { runner: 'mocha', failToPass: [], passToPass: [] },
    constraints: { maxSteps: 0, maxWallMs: 10, maxTokenBudget: -1 },
    scoring: ['outcome', 'telemetry'],
    severity: 'P9',
  }
  const { task, errors } = normalizeTask(bad, { dir: 'E:/eval/tasks', repoRoot: 'E:/eval', file: 'E:/eval/tasks/bad.json' })

  assert.equal(task, null)
  const joined = errors.join('\n')
  assert.match(joined, /id 必须匹配/)
  assert.match(joined, /taskType 必须是/)
  assert.match(joined, /task 提示词缺失/)
  assert.match(joined, /repository\.mode 必须是/)
  assert.match(joined, /verification\.command 缺失/)
  assert.match(joined, /failToPass 不能为空/)
  assert.match(joined, /maxSteps 必须是正整数/)
  assert.match(joined, /maxWallMs 必须 >= 1000/)
  assert.match(joined, /maxTokenBudget 必须是正整数/)
  assert.match(joined, /scoring 只能是/)
  assert.match(joined, /severity 必须是/)
})

test('normalizeTask：worktree 模式要求 repository.path，fixture 模式要求 repository.fixture', () => {
  // path 缺省为 '.'（合法）；显式给空串才应报错
  const worktree = normalizeTask(
    { ...BASE, repository: { mode: 'worktree', path: '' } },
    { dir: 'd', repoRoot: 'r', file: 'd/t.json' },
  )
  assert.match(worktree.errors.join('\n'), /worktree 模式需要 repository\.path/)

  const fixture = normalizeTask({ ...BASE, repository: { mode: 'fixture' } }, { dir: 'd', repoRoot: 'r', file: 'd/t.json' })
  assert.match(fixture.errors.join('\n'), /fixture 模式需要 repository\.fixture/)
})

test('loadTasks：真实语料目录必须无错误、六类齐全、且不把 pricing.json 当任务', async () => {
  const loaded = await loadTasks({ dir: join(EVAL_ROOT, 'tasks'), repoRoot: REPO_ROOT })

  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.inventory.dir, join(EVAL_ROOT, 'tasks'))
  for (const type of TASK_TYPES) {
    assert.ok((loaded.inventory.byType[type] ?? 0) >= 1, `缺少任务类型：${type}`)
  }
  assert.equal(loaded.tasks.some((t) => t.id === 'pricing'), false)
  assert.ok(loaded.inventory.files >= loaded.inventory.total)
})

test('loadTasks：id 重复与 fixture 缺失必须在跑之前报错', async () => {
  await withTempDir(async (dir) => {
    const tasksDir = join(dir, 'tasks')
    await mkdir(join(tasksDir, 'fixtures', 'ok'), { recursive: true })
    await mkdir(join(tasksDir, 'fixtures', 'not-json'), { recursive: true })

    const write = (name, body) => writeFile(join(tasksDir, name), JSON.stringify(body, null, 2), 'utf-8')

    await write('dup-a.json', BASE)
    await write('dup-b.json', BASE)
    await write('missing-fixture.json', { ...BASE, id: 'missing-fixture', repository: { mode: 'fixture', fixture: './fixtures/nope' } })
    await write('pricing.json', { currency: 'CNY', unit: 1_000_000, models: { m: { input: 1 } } })
    await write('_draft.json', { ...BASE, id: 'draft' })
    await writeFile(join(tasksDir, 'fixtures', 'not-json', 'inner.json'), JSON.stringify(BASE), 'utf-8')

    const loaded = await loadTasks({ dir: tasksDir, repoRoot: REPO_ROOT })
    const joined = loaded.errors.join('\n')

    assert.match(joined, /任务 id 重复：sample-task/)
    assert.match(joined, /fixture 目录不存在/)
    // pricing.json、_ 前缀文件、fixtures/ 下的 JSON 都不进任务集
    assert.equal(loaded.tasks.length, 2)
    assert.equal(loaded.inventory.files, 3)
  })
})

test('loadTasks：--ids 只做筛选，不改变校验口径', async () => {
  const all = await loadTasks({ dir: join(EVAL_ROOT, 'tasks'), repoRoot: REPO_ROOT })
  const one = await loadTasks({ dir: join(EVAL_ROOT, 'tasks'), repoRoot: REPO_ROOT, ids: ['smoke-bugfix-off-by-one'] })

  assert.equal(one.tasks.length, 1)
  assert.equal(one.tasks[0].id, 'smoke-bugfix-off-by-one')
  assert.deepEqual(one.errors, [])
  assert.equal(one.inventory.total, all.inventory.total)
})
