/** 工作区画像与环境索引：目录树 / 约定文件 / 版本控制 / 工具链 / 既有校验命令，注入每轮动态上下文。 */
import { exec } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { currentVersion, harnessRoot } from './self-knowledge.js'

// ===== 环境索引（workspace + 项目目录树）：注入动态上下文，省掉模型反复探目录的 token =====

/** 目录树忽略项（按小写名匹配）：依赖 / 构建 / 系统目录对理解项目结构无益，只会浪费 token。 */
export const TREE_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-install', 'dist-update', 'dist-bin',
  'build', 'out', 'target', 'backups', '__pycache__', '.next', '.nuxt', '.cache', '.venv', 'venv',
  'appdata', '$recycle.bin',
])
const TREE_MAX_TOP = 60 // 顶层最多展示条目数
const TREE_MAX_SUBS = 20 // 每个子目录内联展示的children数
const TREE_MAX_CHARS = 4000 // 目录树整体字符上限

/** 读取目录条目（目录在前、文件在后，过滤忽略项）；失败返回空数组。 */
function treeEntries(dir: string): { name: string; isDirectory: () => boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !TREE_IGNORE.has(e.name.toLowerCase()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** 生成两层项目目录树：顶层条目 + 各目录内联 children，让模型一眼看清项目结构。 */
function projectTree(workspace: string): string {
  const top = treeEntries(workspace)
  if (top.length === 0) return ''
  const lines: string[] = []
  let chars = 0
  const push = (line: string): boolean => {
    if (chars + line.length > TREE_MAX_CHARS) {
      lines.push('…（目录树过大，已按字符上限截断）')
      return false
    }
    lines.push(line)
    chars += line.length + 1
    return true
  }
  for (let i = 0; i < top.length; i++) {
    if (i >= TREE_MAX_TOP) {
      push(`…（另有 ${top.length - TREE_MAX_TOP} 个顶层条目未展示）`)
      break
    }
    const e = top[i]
    if (!e.isDirectory()) {
      if (!push(`- ${e.name}`)) break
      continue
    }
    const subs = treeEntries(join(workspace, e.name))
    const names = subs.slice(0, TREE_MAX_SUBS).map((s) => (s.isDirectory() ? `${s.name}/` : s.name)).join(', ')
    const more = subs.length > TREE_MAX_SUBS ? `, …另 ${subs.length - TREE_MAX_SUBS} 项` : ''
    if (!push(`- ${e.name}/${names ? ` (${names}${more})` : ''}`)) break
  }
  return lines.join('\n')
}

// ===== 工作区画像（约定文件 / 版本控制 / 工具链 / 校验命令）：企业级作业的前提信息 =====
// 这些信息缺失时模型只能靠猜：猜用哪个包管理器、猜「验证」该跑什么命令、把用户未提交的在途
// 改动当垃圾清理、无视仓库自带的作业规范。补上后「先遵循仓库约定、改完跑既有校验」才有落点。

/** 项目约定文件（按优先级）：仓库内的作业规范，命中即注入全文并要求遵循。 */
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md']
/** 约定文件注入上限：规范通常不长，超长时截断而不是整份塞进每轮上下文。 */
const MAX_CONVENTION_CHARS = 3000
/** 包管理器探测：按锁文件判定，避免在 pnpm 仓库里用 npm 装包。 */
const LOCKFILES: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]
/** 从 package.json scripts / Makefile 目标里挑出的「校验类」名字：让「未验证不宣告完成」有具体命令可跑。 */
const VERIFY_SCRIPTS = ['check', 'verify', 'typecheck', 'test:e2e', 'test', 'lint', 'build']
/** CI 配置位置（除 GitHub Actions 目录）：CI 是「什么算通过」的权威定义，优先对齐它的命令。 */
const CI_FILES = ['.gitlab-ci.yml', '.gitlab-ci.yaml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', '.circleci/config.yml']
/** CI 命令抽取上限：只需对齐「怎么验」，不必还原整条流水线。 */
const MAX_CI_COMMANDS = 8
/** 语言标准校验命令：仓库既没声明脚本也无 CI 时，按语言惯例给出可跑通的验证入口。 */
const LANGUAGE_VERIFY: Array<[string, string, string[]]> = [
  ['pyproject.toml', 'Python', ['pytest -q', 'ruff check .']],
  ['requirements.txt', 'Python', ['pytest -q']],
  ['go.mod', 'Go', ['go build ./...', 'go vet ./...', 'go test ./...']],
  ['Cargo.toml', 'Rust', ['cargo clippy', 'cargo test']],
  ['pom.xml', 'Java/Maven', ['mvn -q verify']],
  ['build.gradle', 'Java/Gradle', ['./gradlew build']],
  ['build.gradle.kts', 'Java/Gradle', ['./gradlew build']],
]

/** 常见测试框架：知道仓库用哪套，补测试才会落在既有体系里而不是另起平行工程。 */
const TEST_FRAMEWORKS = ['vitest', 'jest', 'mocha', 'ava', 'jasmine', '@playwright/test', 'playwright']

/** 构建产物目录：改源代码而非手改产物——「改了 dist 没改 src」是企业仓库最常见的隐形事故。 */
const BUILD_DIRS = ['dist', 'dist-bin', 'build', 'out', 'target']

/** 安全的存在性判断：路径不可读时按不存在处理，不影响环境块生成。 */
function exists(file: string): boolean {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/** 读取文本文件并按上限截断；不存在 / 不可读 / 为空时返回 undefined。 */
async function readTextCapped(file: string, maxChars: number): Promise<string | undefined> {
  try {
    const text = (await readFile(file, 'utf8')).trim()
    if (!text) return undefined
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（内容过长已截断）` : text
  } catch {
    return undefined
  }
}

/**
 * 从 CI 配置里抽取可执行的校验命令（GitHub Actions / GitLab CI 等普遍用 `run:` / `script:`）。
 * CI 是「什么算通过」的权威定义：对齐它，模型就不会自造一套验证方式或漏掉仓库真正的门禁。
 */
async function ciVerifyCommands(workspace: string): Promise<{ source: string; commands: string[] } | undefined> {
  const files: string[] = []
  const workflowDir = join(workspace, '.github', 'workflows')
  if (exists(workflowDir)) {
    try {
      for (const f of readdirSync(workflowDir)) if (/\.ya?ml$/i.test(f)) files.push(join(workflowDir, f))
    } catch {
      // 目录不可读时忽略，不影响其它画像项
    }
  }
  for (const f of CI_FILES) if (exists(join(workspace, f))) files.push(join(workspace, f))
  if (files.length === 0) return undefined

  const commands: string[] = []
  for (const file of files) {
    const text = await readTextCapped(file, 200_000)
    if (!text) continue
    for (const line of text.split(/\r?\n/)) {
      const matched = /^\s*(?:-\s*)?(?:run|script)\s*:\s*(.+)$/.exec(line)
      if (!matched) continue
      const cmd = matched[1].trim().replace(/^['"]|['"]$/g, '')
      // 过滤非命令噪音（块标量、变量插值、空值）与超长行
      if (!cmd || /^[|>$]/.test(cmd) || cmd.length > 120) continue
      commands.push(cmd)
    }
  }
  const uniq = [...new Set(commands)]
  // 用「排除噪音」而非「白名单校验词」：CI 里的校验命令千变万化（bundle / e2e / smoke / 自定义脚本），
  // 白名单会静默漏掉真实门禁；只剔除安装、登录、发布、上传产物这类与「验证是否通过」无关的步骤。
  const NOISE = /\b(?:install|checkout|setup|cache|upload|download|artifact|echo|mkdir|login|logout|docker|deploy|publish|release|sleep)\b/i
  const meaningful = uniq.filter((c) => !NOISE.test(c))
  const picked = (meaningful.length > 0 ? meaningful : uniq).slice(0, MAX_CI_COMMANDS)
  if (picked.length === 0) return undefined
  return { source: files.map((f) => relative(workspace, f).replace(/\\/g, '/')).join(' / '), commands: picked }
}

/** 从 Makefile / justfile 里按名挑出「校验类」目标：按名匹配，避免瞎猜仓库入口。 */
async function makeTargets(workspace: string): Promise<string[]> {
  for (const [file, runner] of [['Makefile', 'make'], ['justfile', 'just']] as const) {
    const text = await readTextCapped(join(workspace, file), 20_000)
    if (!text) continue
    const names = [...text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1])
    const picked = [...new Set(names.filter((n) => VERIFY_SCRIPTS.includes(n) || /^(?:check|verify|test|lint|build)/.test(n)))]
    if (picked.length > 0) return picked.slice(0, 5).map((n) => `${runner} ${n}`)
  }
  return []
}

/**
 * 解析 `git status --porcelain=v1 --branch` 输出为一行中文状态描述；无法解析时返回 undefined。
 * 未提交改动会被明确标注「可能是用户未完成的工作」，避免模型把在途改动当垃圾清理。
 */
export function parseGitStatus(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = lines.find((l) => l.startsWith('##'))
  if (!head) return undefined
  const branch = head.slice(2).split('...')[0].trim() || '(游离 HEAD)'
  const changed = lines.filter((l) => !l.startsWith('##')).length
  return changed === 0
    ? `分支 ${branch}，工作区干净（无未提交改动）`
    : `分支 ${branch}，有 ${changed} 个未提交改动（那可能是用户未完成的工作，动手前先弄清来历）`
}

/** 读取版本控制状态；非 git 仓库或 git 不可用时返回 undefined（不阻塞环境块生成）。 */
function gitSummary(workspace: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    exec(
      'git status --porcelain=v1 --branch',
      { cwd: workspace, timeout: 5000, maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : parseGitStatus(stdout)),
    )
  })
}

/** 最近几条提交标题：让「提交信息跟随仓库既有风格」有可对照的样例，而非凭感觉写。 */
function recentCommitSubjects(workspace: string, count = 3): Promise<string[]> {
  return new Promise((resolve) => {
    exec(
      `git log -${count} --pretty=%s`,
      { cwd: workspace, timeout: 5000, maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout) =>
        resolve(
          err
            ? []
            : stdout
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean)
                // 只借风格：超长标题截断，避免个别 commit 吃掉上下文
                .map((l) => (l.length > 80 ? `${l.slice(0, 80)}…` : l)),
        ),
    )
  })
}

/** 组装工作区画像（约定文件内容 + 版本控制 + 工具链 + 仓库既有校验命令），失败项自动省略。 */
export async function buildWorkspaceProfile(workspace: string): Promise<string> {
  const lines: string[] = []

  // 约定文件：命中即注入内容，让「遵循仓库规范」有据可依
  for (const name of CONVENTION_FILES) {
    const content = await readTextCapped(join(workspace, name), MAX_CONVENTION_CHARS)
    if (content) {
      lines.push(
        `- 项目约定文件 ${name}（本仓库作业规范，必须遵循；内容已在此给出，无需再 read_file 该文件，被截断时才读取剩余部分；与用户即时指令冲突时以用户为准并说明）：\n${content}\n`,
      )
      break
    }
  }

  const git = await gitSummary(workspace)
  if (git) lines.push(`- 版本控制：git，${git}；\n`)
  const subjects = git ? await recentCommitSubjects(workspace) : []
  if (subjects.length > 0) lines.push(`- 最近提交（新提交的措辞照此风格，未经用户要求不 commit/push）：${subjects.join(' / ')}；\n`)

  const pkgManager = LOCKFILES.find(([f]) => exists(join(workspace, f)))?.[1]
  const language = LANGUAGE_VERIFY.find(([f]) => exists(join(workspace, f)))

  // package.json 只读一次：工具链（engines/测试框架）与校验脚本共用
  const pkgText = await readTextCapped(join(workspace, 'package.json'), 200_000)
  let pkg: {
    scripts?: Record<string, string>
    engines?: { node?: string }
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } = {}
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText) as typeof pkg
    } catch {
      // package.json 不是合法 JSON 时忽略，不影响其它画像项
    }
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies }
  const testFramework = TEST_FRAMEWORKS.find((f) => deps[f])

  // 本机运行时与项目声明的要求分开写：把运行时版本当项目版本会让模型误判可用语法与依赖约束
  let nodeReq = pkg.engines?.node
  if (!nodeReq) {
    for (const file of ['.nvmrc', '.node-version']) {
      const pinned = await readTextCapped(join(workspace, file), 100)
      if (pinned) {
        nodeReq = pinned
        break
      }
    }
  }
  const toolchain = [
    pkgManager ? `包管理器 ${pkgManager}` : '',
    language ? language[1] : '',
    exists(join(workspace, 'tsconfig.json')) ? 'TypeScript' : '',
    testFramework ? `测试框架 ${testFramework}` : '',
    // Node 只在 Node 系项目里提：非 Node 仓库写本机 Node 版本纯属噪音
    pkgText ? `Node 运行时 ${process.version}（本机可用）` : '',
    nodeReq ? `项目要求 Node ${nodeReq.replace(/\s+/g, ' ')}` : '',
  ].filter(Boolean)
  lines.push(`- 工具链：${toolchain.join('；')}；\n`)

  // 构建产物：说清「产物的源头是源文件」，省掉「手改 dist 让测试变绿」这类假修复
  const artifacts = BUILD_DIRS.filter((d) => exists(join(workspace, d)))
  if (artifacts.length > 0) {
    lines.push(
      `- 构建产物目录（${artifacts.join('、')}）：由构建生成，改动一律落在源文件后用本块的校验/构建命令重建；不要手改产物，产物里的问题要回溯到源文件修；\n`,
    )
  }

  // 校验来源优先级：CI 同款命令（权威）> 仓库声明脚本 > 语言标准命令。
  const ci = await ciVerifyCommands(workspace)
  if (ci) {
    lines.push(
      `- CI 校验来源（${ci.source}）：CI 是「什么算通过」的权威定义，改动后优先在本地跑同款命令自证，不得改 CI 配置来绕开失败：${ci.commands.join(' / ')}；\n`,
    )
  }

  let declared = VERIFY_SCRIPTS.filter((s) => pkg.scripts?.[s]).map((s) => `${pkgManager ?? 'npm'} run ${s}`)
  declared = [...declared, ...(await makeTargets(workspace))]
  if (declared.length > 0) {
    lines.push(`- 仓库既有校验命令（改完代码用这些证明可用，不要另造验证方式）：${declared.join(' / ')}；\n`)
  } else if (!ci && language) {
    lines.push(`- 仓库未声明校验脚本：按 ${language[1]} 惯例用标准命令自证：${language[2].join(' / ')}；\n`)
  }

  return lines.join('')
}

/** 组装环境索引块：平台、工作区绝对路径、项目目录树与工作区画像，注入每轮动态上下文。 */
export async function buildEnvironmentNotes(workspace: string): Promise<string> {
  const root = process.env.HARNESS_ROOT
  const located = harnessRoot()
  const tree = projectTree(workspace)
  const profile = await buildWorkspaceProfile(workspace)
  const win = process.platform === 'win32'
  return (
    '\n\n# Environment\n' +
    `- 本体：Zhuxing Harness v${currentVersion()}；平台：${process.platform}；shell：${win ? 'cmd.exe' : '/bin/sh'}；运行形态：${root ? `安装态（HARNESS_ROOT=${root}）` : '源码开发仓'}；\n` +
    `- 命令面：shell 工具固定用 ${win ? 'cmd.exe' : '/bin/sh'} 执行（Windows 下用 dir/type/findstr/copy 等内建命令，勿用 ls/wc/grep/head、2>/dev/null、单引号包路径等 Unix 写法）；文件与目录的读/写/列举一律优先用 read_file/write_file/list_dir，跨文件找内容用 search_files（勿用 findstr/grep 硬凑），shell 仅用于确需执行命令的场景；\n` +
    (located ? `- 本体位置：${located}（本体自身代码/安装根，通常在工作区之外；问及本体实现时直接在此定位）；\n` : '') +
    `- 工作区（项目根，工具相对路径均以此为基准；shell 命令默认就在此目录下执行，无需 cd）：${workspace}；\n` +
    (tree
      ? `- 项目目录树（工作区结构索引：顶层条目 + 各目录内联 children，省略依赖/构建目录；超上限处会标注「…另 N 项」）：\n${tree}\n` +
        '- 上表即索引：目标文件能在此定位就直接 read_file，不要再 list_dir 复核（重复列目录只浪费回合）；索引未覆盖或标注「另 N 项」时才 list_dir 下探，勿反复列目录探路；\n' +
        '- 禁止全盘扫描（dir /s、where /r、find /、grep -r 等）：索引里没有就逐层 list_dir 下探，勿扫盘碰运气；工作区以外的其它路径先向用户确认，但本体位置例外——查本体实现直接用 search_files/read_file 在其内定位（只读不改）。'
      : '- 工作区目录为空或不可读，需要时自行 list_dir 探明。') +
    profile
  )
}
