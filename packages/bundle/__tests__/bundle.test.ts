import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseBundlePlugins, buildWorkspaceProfile, parseGitStatus, pickRecentBriefs, renderSelfKnowledge } from '../src/index.js'
import type { ToolDefinition } from '@zhuxing/harness-tools'

/** 用假工具注册表应用 harness-core-tools，取出真实工具定义用于单测。 */
function coreTool(name: string, workspace: string): ToolDefinition {
  const plugins = baseBundlePlugins({ apiKey: 'k', model: 'm', workspace, level: 'workspace-write' })
  const core = plugins.find((p) => p.name === 'harness-core-tools')!
  const registered = new Map<string, ToolDefinition>()
  const fakeCtx = {
    config: {},
    inject: () => ({
      register: (def: ToolDefinition) => {
        registered.set(def.name, def)
        return () => {}
      },
    }),
  }
  core.apply(fakeCtx as never)
  return registered.get(name)!
}

describe('基础 bundle', () => {
  it('以插件形态提供全部基础能力（无特权核心）', () => {
    const plugins = baseBundlePlugins({
      apiKey: 'k',
      model: 'm',
      workspace: process.cwd(),
      level: 'workspace-write',
    })
    expect(plugins.map((p) => p.name)).toEqual([
      'harness-sandbox',
      'harness-session',
      'harness-tools',
      'harness-llm',
      'harness-telemetry',
      'harness-core-tools',
      'harness-self-knowledge',
      'harness-image-tools',
      'harness-token-plan-media',
      'harness-memory',
      'harness-knowledge',
      'harness-skill-loader',
      'harness-model-router',
      'harness-agent',
    ])
    const agent = plugins.find((p) => p.name === 'harness-agent')!
    expect(agent.inject).toEqual(['llm', 'tools', 'sessionService'])
    const router = plugins.find((p) => p.name === 'harness-model-router')!
    expect(router.inject).toEqual(['llm', 'tools'])
    const memory = plugins.find((p) => p.name === 'harness-memory')!
    expect(memory.inject).toEqual(['tools'])
    const skillLoader = plugins.find((p) => p.name === 'harness-skill-loader')!
    expect(skillLoader.inject).toEqual(['tools'])
    // 本体自省插件只依赖工具注册表（提供 harness_help）
    const selfKnowledge = plugins.find((p) => p.name === 'harness-self-knowledge')!
    expect(selfKnowledge.inject).toEqual(['tools'])
  })
})

describe('本体自省', () => {
  it('按话题渲染软件本体知识：版本 / 路径 / 命令 / 端点 / 流程', () => {
    const overview = renderSelfKnowledge('overview', { workspace: 'E:\\proj' })
    expect(overview).toContain('筑星 Harness 本体')
    expect(overview).toContain('E:\\proj')
    expect(renderSelfKnowledge('commands')).toContain('update [--check')
    expect(renderSelfKnowledge('api')).toContain('GET /api/update/status')
    expect(renderSelfKnowledge('paths')).toContain('config.json')
    expect(renderSelfKnowledge('flows')).toContain('内核自更新')
  })

  it('插件与工具清单取运行时实况；缺实时数据时给出获取方式', () => {
    const live = renderSelfKnowledge('tools', { tools: [{ name: 'shell', description: '执行一条命令' }] })
    expect(live).toContain('运行时注册实况')
    expect(live).toContain('- shell：执行一条命令')
    expect(renderSelfKnowledge('plugins')).toContain('harness list')
    expect(renderSelfKnowledge('tools')).toContain('harness tools list')
  })

  it('未知话题返回总览并提示可用话题，不抛错', () => {
    const text = renderSelfKnowledge('nope')
    expect(text).toContain('未知话题')
    expect(text).toContain('筑星 Harness 本体')
  })
})

describe('内建工具', () => {
  it('search_files 跨文件返回 路径:行号:内容，跳过 node_modules，支持 ext 过滤与非法正则降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-search-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const goal = 1\nno hit\n')
    writeFileSync(join(dir, 'src', 'b.md'), 'goal in markdown\n')
    writeFileSync(join(dir, 'node_modules', 'x', 'c.ts'), 'const goal = 2\n')

    const search = coreTool('search_files', dir)
    const all = await search.execute!({ pattern: 'goal' }, {} as never)
    expect(all.error).toBeUndefined()
    const text = String(all.text)
    expect(text).toContain(join('src', 'a.ts') + ':1:')
    expect(text).toContain(join('src', 'b.md') + ':1:')
    expect(text).not.toContain('node_modules')

    const onlyTs = await search.execute!({ pattern: 'goal', ext: '.ts' }, {} as never)
    expect(String(onlyTs.text)).not.toContain('.md')

    // 非法正则（含未配对括号）降级为字面量匹配，不应报错
    const literal = await search.execute!({ pattern: 'goal = 1(' }, {} as never)
    expect(literal.error).toBeUndefined()
    expect(String(literal.text)).toContain('未找到匹配')

    const none = await search.execute!({ pattern: 'zzz-not-exist' }, {} as never)
    expect(String(none.text)).toContain('未找到匹配')
  })

  it('write_file 自动补建不存在的父目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-write-'))
    const write = coreTool('write_file', dir)
    const res = await write.execute!({ path: 'deep/nested/out.txt', content: 'hi' }, {} as never)
    expect(res.error).toBeUndefined()
    expect(String(res.text)).toContain('已写入')
  })
})

describe('交付简报选取', () => {
  const brief = (n: number, len = 10) => ({
    id: `b${n}`,
    scope: 'session' as const,
    content: `简报${n}` + 'x'.repeat(len),
    createdAt: n,
    updatedAt: n,
  })

  it('只取最近若干份（份数上限），并保持时间顺序', () => {
    const picked = pickRecentBriefs([1, 2, 3, 4, 5, 6, 7, 8].map((n) => brief(n)), 3)
    expect(picked.map((e) => e.id)).toEqual(['b6', 'b7', 'b8'])
  })

  it('超字符预算时从最旧的开始丢，至少保留最近一份', () => {
    const picked = pickRecentBriefs([1, 2, 3].map((n) => brief(n, 100)), 6, 150)
    expect(picked.map((e) => e.id)).toEqual(['b3'])
    expect(pickRecentBriefs([brief(1, 100)], 6, 10).length).toBe(1)
  })

  it('空输入返回空数组', () => {
    expect(pickRecentBriefs([])).toEqual([])
  })
})

describe('工作区画像', () => {
  it('解析 git 状态：干净 / 有未提交改动 / 非仓库', () => {
    expect(parseGitStatus('## main...origin/main\n')).toBe('分支 main，工作区干净（无未提交改动）')
    const dirty = parseGitStatus('## feature/x...origin/feature/x [ahead 1]\n M a.ts\n?? b.ts\n')
    expect(dirty).toContain('分支 feature/x')
    expect(dirty).toContain('2 个未提交改动')
    expect(parseGitStatus('fatal: not a git repository (or any of the parent directories)')).toBeUndefined()
  })

  it('组装画像：注入约定文件内容、工具链与仓库既有校验命令', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-'))
    writeFileSync(join(dir, 'AGENTS.md'), '# 仓库规范\n改完先跑 typecheck 再提交\n')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }))

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('项目约定文件 AGENTS.md')
    expect(profile).toContain('改完先跑 typecheck 再提交')
    expect(profile).toContain('包管理器 pnpm')
    expect(profile).toContain('TypeScript')
    expect(profile).toContain('pnpm run typecheck / pnpm run test')
  })

  it('聚合式校验入口 check 也纳入（仓库常用「一条命令跑全部」）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-check-'))
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'pnpm build && pnpm test', bundle: 'node bundle.mjs' } }))

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('pnpm run check')
    // 非校验类脚本不该混进校验命令清单
    expect(profile).not.toContain('pnpm run bundle')
  })

  it('识别测试框架与构建产物目录（补测试落在既有体系，产物不手改）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-stack-'))
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('测试框架 vitest')
    expect(profile).toContain('构建产物目录（dist）')
  })

  it('无约定文件、无 package.json 时仍给出工具链，不抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-empty-'))
    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('工具链：')
    expect(profile).not.toContain('项目约定文件')
    expect(profile).not.toContain('仓库既有校验命令')
    expect(profile).not.toContain('构建产物目录')
  })

  it('本机 Node 运行时与项目声明要求分开：engines / .nvmrc 都要认', async () => {
    const byEngines = mkdtempSync(join(tmpdir(), 'h-profile-engines-'))
    writeFileSync(join(byEngines, 'package.json'), JSON.stringify({ engines: { node: '>=20 <23' } }))
    const a = await buildWorkspaceProfile(byEngines)
    expect(a).toContain(`Node 运行时 ${process.version}（本机可用）`)
    expect(a).toContain('项目要求 Node >=20 <23')

    const byNvmrc = mkdtempSync(join(tmpdir(), 'h-profile-nvmrc-'))
    writeFileSync(join(byNvmrc, 'package.json'), '{}')
    writeFileSync(join(byNvmrc, '.nvmrc'), '18.19.0\n')
    const b = await buildWorkspaceProfile(byNvmrc)
    expect(b).toContain('项目要求 Node 18.19.0')
  })

  it('CI 是校验权威口径：抽取 workflow 里的校验命令并标注来源', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-ci-'))
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'jobs:',
        '  quality:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: pnpm install --frozen-lockfile',
        '      - run: pnpm -r build',
        '      - run: pnpm test:e2e',
        '      - run: pnpm bundle',
        '      - run: docker login -u x',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { verify: 'node scripts/verify.mjs' } }))

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('CI 校验来源（.github/workflows/ci.yml）')
    expect(profile).toContain('pnpm test:e2e')
    // 非白名单词的门禁也要保留：bundle 失败同样是 CI 红
    expect(profile).toContain('pnpm bundle')
    // 安装、发布类步骤与验证无关，不应占上下文
    expect(profile).not.toContain('pnpm install --frozen-lockfile')
    expect(profile).not.toContain('docker login')
    // 与仓库脚本并存时两条都给出，让模型知道 CI 是权威口径
    expect(profile).toContain('仓库既有校验命令')
  })

  it('Makefile 目标按名识别为校验入口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-make-'))
    writeFileSync(
      join(dir, 'Makefile'),
      ['CC := gcc', 'all: build', 'build:', '\tgo build ./...', 'test:', '\tgo test ./...', 'deploy:', '\tship'].join('\n'),
    )

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('make build')
    expect(profile).toContain('make test')
    expect(profile).not.toContain('make deploy')
    expect(profile).not.toContain('make CC')
  })

  it('非 Node 仓库无声明脚本时回落到语言标准校验命令', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-profile-go-'))
    writeFileSync(join(dir, 'go.mod'), 'module demo\n')

    const profile = await buildWorkspaceProfile(dir)
    expect(profile).toContain('工具链：Go')
    expect(profile).toContain('仓库未声明校验脚本')
    expect(profile).toContain('go test ./...')
  })
})
