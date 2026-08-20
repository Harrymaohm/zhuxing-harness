import { describe, expect, it } from 'vitest'
import { createSandbox } from '../src/index.js'

describe('沙箱策略', () => {
  it('read-only 拒绝写类命令', () => {
    const sandbox = createSandbox({ level: 'read-only', workspace: process.cwd() })
    expect(() => sandbox.checkCommand('rm -rf /')).toThrow(/read-only/)
    expect(() => sandbox.checkCommand('echo x > /etc/passwd')).toThrow(/read-only/)
    expect(() => sandbox.checkCommand('git push origin main')).toThrow(/read-only/)
    expect(() => sandbox.checkCommand('ls -la')).not.toThrow()
  })

  it('read-only 只拦截写意图，放行只读查询（优化后）', () => {
    const sandbox = createSandbox({ level: 'read-only', workspace: process.cwd() })
    // 纯查询命令应放行
    for (const cmd of [
      'git status',
      'git log --oneline -5',
      'git diff HEAD',
      'sed -n \'1,10p\' README.md',
      'awk \'{print $1}\' data.txt',
      'grep -r "TODO" src',
      'find . -name "*.ts"',
      'cat package.json',
      'head -20 README.md',
      'tail -10 README.md',
      'npm view react version',
      'pip list',
      'curl -s https://example.com/api',
      'echo $HOME',
      'ls -la packages',
      'python3 -c "print(1+1)"',
    ]) {
      expect(() => sandbox.checkCommand(cmd)).not.toThrow(`应放行只读查询：${cmd}`)
    }
    // 明确的写意图仍应拦截
    for (const cmd of [
      'sed -i \'s/a/b/\' file.txt',
      'curl -o /tmp/x https://example.com',
      'npm install',
      'npm run build',
      'echo done > out.txt',
      'rm -rf node_modules',
      'cp a.txt b.txt',
    ]) {
      expect(() => sandbox.checkCommand(cmd)).toThrow(/read-only/)
    }
  })

  it('read-only 拒绝任何写入', () => {
    const sandbox = createSandbox({ level: 'read-only', workspace: process.cwd() })
    expect(() => sandbox.checkWrite('/tmp/x')).toThrow(/read-only/)
  })

  it('workspace-write 允许工作区内写入，拒绝外部', () => {
    const ws = process.cwd()
    const sandbox = createSandbox({ level: 'workspace-write', workspace: ws })
    expect(() => sandbox.checkWrite(`${ws}/a.txt`)).not.toThrow()
    expect(() => sandbox.checkWrite('C:/outside/x.txt')).toThrow(/工作区外/)
  })

  it('workspace-write 放行命令，deniedCommands 优先', () => {
    const sandbox = createSandbox({
      level: 'workspace-write',
      workspace: process.cwd(),
      deniedCommands: ['rm '],
    })
    expect(() => sandbox.checkCommand('ls')).not.toThrow()
    expect(() => sandbox.checkCommand('rm -rf x')).toThrow(/deniedCommands/)
  })

  it('danger-full-access 全放行', () => {
    const sandbox = createSandbox({ level: 'danger-full-access', workspace: process.cwd() })
    expect(() => sandbox.checkCommand('rm -rf /')).not.toThrow()
    expect(() => sandbox.checkWrite('/outside')).not.toThrow()
  })

  it('allowedCommands 在 read-only 下放行指定命令', () => {
    const sandbox = createSandbox({
      level: 'read-only',
      workspace: process.cwd(),
      allowedCommands: ['git status'],
    })
    expect(() => sandbox.checkCommand('git status')).not.toThrow()
    expect(() => sandbox.checkCommand('git push')).toThrow()
  })
})
