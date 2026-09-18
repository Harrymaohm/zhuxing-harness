import { parseArgs } from 'node:util'
import { loadConfig } from '../config-store.js'
import { fmt, out, outError } from '../output.js'
import { applyLocalZip, applyRemoteUpdate, checkUpdate } from '../updater.js'

/** 启动 Web UI（对话 / 工作 / 交付）。 */
export async function cmdWeb(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
    },
  })
  const { startWebServer } = await import('@zhuxing/harness-web')
  const handle = await startWebServer({
    port: values.port ? Number(values.port) : 3080,
    host: values.host ?? '127.0.0.1',
  })
  out(`${fmt.green('✓')} 筑星 Harness Web UI 已启动：${handle.url}`)
  out('（Ctrl-C 退出）')
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop)
  })
  await new Promise<void>((resolveClose) => handle.server.close(() => resolveClose()))
}

/** 应用内更新：检查 / 下载 / 手动安装增量包。 */
export async function cmdUpdate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: 'boolean' },
      url: { type: 'string' },
      file: { type: 'string' },
    },
  })

  // 手动安装本地增量包（--file <zip>）
  if (values.file) {
    const result = await applyLocalZip(values.file)
    if (result.ok) {
      out(`${fmt.green('✓')} 更新完成：${result.fromVersion} → ${result.toVersion}`)
      if (result.backedUpTo) out(`${fmt.dim('备份：')}${result.backedUpTo}`)
    } else {
      outError(`✗ 更新失败：${result.error}`)
      process.exitCode = 1
    }
    return
  }

  // 解析更新源
  const url = values.url ?? process.env.HARNESS_UPDATE_URL ?? (loadConfig().updateUrl as string | undefined)
  if (!url) {
    outError('✗ 未配置更新源。请通过 --url、HARNESS_UPDATE_URL 或 config 的 updateUrl 指定。')
    process.exitCode = 2
    return
  }

  // 仅检查
  if (values.check) {
    try {
      const check = await checkUpdate(url)
      out(`当前版本：${check.currentVersion}`)
      out(`最新版本：${check.latestVersion}`)
      if (check.hasUpdate) {
        out(`${fmt.yellow('↑')} 发现新版本：${check.latestVersion}`)
        if (check.releaseNotes) out(fmt.dim(check.releaseNotes))
      } else {
        out(`${fmt.green('✓')} 已是最新版本`)
      }
      // 安装包轨：Electron 运行时变更不走 zip，只能下载新安装包重装
      if (check.installerUpdate) {
        out(`${fmt.yellow('⬇')} 安装包轨：发现新版桌面安装包 ${check.installerUpdate.version}（增量包不承载 Electron 运行时）`)
        if (check.installerUpdate.url) out(fmt.dim(check.installerUpdate.url))
        if (check.installerUpdate.notes) out(fmt.dim(check.installerUpdate.notes))
      }
    } catch (err) {
      outError(`✗ 检查更新失败：${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
    return
  }

  // 完整更新：检查 → 下载 → 校验 → 应用
  out(`${fmt.cyan('▶')} 检查更新…`)
  try {
    const result = await applyRemoteUpdate(url)
    if (result.ok) {
      if (result.toVersion === result.fromVersion) {
        out(`${fmt.green('✓')} 已是最新版本（${result.fromVersion}）`)
      } else {
        out(`${fmt.green('✓')} 更新完成：${result.fromVersion} → ${result.toVersion}`)
        if (result.backedUpTo) out(`${fmt.dim('备份：')}${result.backedUpTo}`)
      }
    } else {
      outError(`✗ 更新失败：${result.error}`)
      process.exitCode = 1
    }
  } catch (err) {
    outError(`✗ 更新失败：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

export async function cmdCompletion(args: string[]): Promise<void> {
  const shell = args[0] ?? 'bash'
  const commands = 'run dev login config session space validate create-plugin install list introspect doctor version completion help'
  if (shell === 'zsh') {
    out(`#compdef harness
_harness() {
  local -a cmds
  cmds=(${commands})
  _describe 'command' cmds
}
compdef _harness harness`)
    return
  }
  out(`# bash completion for harness
_harness() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${commands}"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _harness harness`)
}
