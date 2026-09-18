#!/usr/bin/env node
import { HarnessError } from '@zhuxing/harness-kernel'
import { loadConfig } from './config-store.js'
import { HELP } from './help.js'
import { VERSION } from './version.js'
import { fmt, out, outError } from './output.js'
import { cmdLogin, cmdConfig } from './commands/config.js'
import { cmdRun } from './commands/run.js'
import {
  cmdValidate,
  cmdCreatePlugin,
  cmdInstall,
  cmdList,
  cmdPluginKeygen,
  cmdPluginSign,
  cmdPluginVerify,
} from './commands/plugin.js'
import { cmdSession, cmdSpace } from './commands/session.js'
import { cmdMemory } from './commands/memory.js'
import { cmdSkill } from './commands/skill.js'
import { cmdTools } from './commands/tools.js'
import { cmdModels } from './commands/models.js'
import { cmdDev } from './commands/dev.js'
import { cmdWeb, cmdUpdate, cmdCompletion } from './commands/misc.js'
import { cmdIntrospect, cmdDoctor } from './commands/diagnostics.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    const cfg = loadConfig()
    if (!cfg.apiKey) {
      out('欢迎使用筑星 Harness。先完成模型配置即可开始工作。')
      await cmdLogin()
      return
    }
    console.log(HELP)
    return
  }
  const [command, ...rest] = argv
  switch (command) {
    case 'run':
      await cmdRun(rest)
      break
    case 'validate':
      await cmdValidate(rest)
      break
    case 'create-plugin':
      await cmdCreatePlugin(rest)
      break
    case 'install':
      await cmdInstall(rest)
      break
    case 'plugin-keygen':
      await cmdPluginKeygen(rest)
      break
    case 'plugin-sign':
      await cmdPluginSign(rest)
      break
    case 'plugin-verify':
      await cmdPluginVerify(rest)
      break
    case 'list':
      await cmdList(rest)
      break
    case 'login':
      await cmdLogin()
      break
    case 'config':
      await cmdConfig(rest)
      break
    case 'session':
      await cmdSession(rest)
      break
    case 'space':
      await cmdSpace(rest)
      break
    case 'models':
      await cmdModels(rest)
      break
    case 'memory':
      await cmdMemory(rest)
      break
    case 'skill':
      await cmdSkill(rest)
      break
    case 'tools':
      await cmdTools(rest)
      break
    case 'dev':
      await cmdDev(rest)
      break
    case 'completion':
      await cmdCompletion(rest)
      break
    case 'doctor':
      await cmdDoctor(rest)
      break
    case 'introspect':
      await cmdIntrospect(rest)
      break
    case 'web':
      await cmdWeb(rest)
      break
    case 'update':
      await cmdUpdate(rest)
      break
    case 'version':
    case '-v':
    case '--version':
      out(`zhuxing-harness v${VERSION}`)
      break
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      break
    default:
      outError(`未知命令：${command}\n`)
      console.log(HELP)
      process.exitCode = 2
  }
}

main().catch((err) => {
  const he = HarnessError.from(err)
  outError(`${fmt.red('✗')} 执行失败：${he.message}`)
  if (he.hint) outError(`  提示：${he.hint}`)
  process.exitCode = 1
})
