import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const cliPath = resolve(fileURLToPath(new URL('../dist/cli.js', import.meta.url)))

function run(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('CLI 进程级冒烟', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'zhuxing-cli-test-'))

  it('help 输出全部命令', () => {
    const help = run(['help'])
    for (const cmd of ['run', 'dev', 'login', 'config', 'session', 'validate', 'create-plugin', 'install', 'list', 'completion']) {
      expect(help).toContain(`harness ${cmd}`)
    }
  })

  it('validate 校验 TS 插件通过', () => {
    const plugin = join(repoRoot, 'examples', 'hello-plugin', 'src', 'index.ts')
    const out = run(['validate', plugin])
    expect(out).toContain('校验通过')
    expect(out).toContain('hello-plugin')
  })

  it('list 解析 patch 配置', () => {
    const patch = join(repoRoot, 'examples', 'hello-plugin.patch.yml')
    const out = run(['list', '--patch', patch])
    expect(out).toContain('hello-plugin')
  })

  it('completion 生成 bash/zsh 补全', () => {
    expect(run(['completion', 'bash'])).toContain('complete -F _harness harness')
    expect(run(['completion', 'zsh'])).toContain('compdef _harness harness')
  })

  it('config set/list/get 脱敏', () => {
    const cfg = join(tmpDir, 'cfg.json')
    run(['config', 'set', 'model', 'test-m'], { HARNESS_CONFIG: cfg })
    run(['config', 'set', 'apiKey', 'sk-abcdef1234567890'], { HARNESS_CONFIG: cfg })
    const list = run(['config', 'list'], { HARNESS_CONFIG: cfg })
    expect(list).toContain('sk-***890')
    expect(list).not.toContain('abcdef123456')
    const get = run(['config', 'get', 'apiKey'], { HARNESS_CONFIG: cfg })
    expect(get).toContain('***')
  })

  it('session ls 空目录提示', () => {
    const out = run(['session', 'ls'], { HARNESS_SESSION_DIR: join(tmpDir, 'sessions') })
    expect(out).toContain('无会话')
  })

  it('version 输出版本号', () => {
    expect(run(['version'])).toMatch(/zhuxing-harness v\d+\.\d+\.\d+/)
    expect(run(['-v'])).toMatch(/v\d+\.\d+\.\d+/)
  })

  it('doctor 输出检查项与结论', () => {
    let out = ''
    try {
      out = run(['doctor'], { HARNESS_CONFIG: join(tmpDir, 'doc.json'), HARNESS_SESSION_DIR: join(tmpDir, 'sess') })
    } catch (err) {
      // 无 API Key 时 doctor 以非零码退出，输出在 stdout
      out = String((err as { stdout?: Buffer | string }).stdout ?? '')
    }
    expect(out).toContain('Node 版本')
    expect(out).toContain('API Key')
    expect(out).toContain('会话目录')
  })

  it('用法错误退出码为 2', () => {
    let code = 0
    try {
      execFileSync(process.execPath, [cliPath, 'validate'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      code = (err as { status?: number }).status ?? -1
    }
    expect(code).toBe(2)
  })

  it('缺少 API Key 的 run 输出分类错误与提示', () => {
    let out = ''
    try {
      execFileSync(process.execPath, [cliPath, 'run', '测试任务'], {
        encoding: 'utf-8',
        env: { ...process.env, HARNESS_CONFIG: join(tmpDir, 'empty.json') },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      // 命令以非零码退出，错误输出在 stderr
      out = String((err as { stderr?: Buffer | string }).stderr ?? '')
    }
    expect(out).toContain('缺少 API Key')
    expect(out).toContain('harness login')
  })
})
