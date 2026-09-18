/**
 * 本体自省（辅助程序）：把「软件本体知识」从系统提示词里搬出来，改为运行时按需生成。
 *
 * 为什么这样做（建立软件 ↔ 提示词的连接，并省 token）：
 * - 提示词只留一行指引（调用 harness_help 工具 / harness introspect 命令），不再常驻命令、端点、
 *   路径、内置流程等长文本，每轮上下文开销大幅下降；
 * - 知识内容由本程序在运行时生成：版本读安装根的 VERSION、插件与工具读内核注册表，
 *   软件升级或插件增减后模型看到的知识随之更新，不会出现「提示词写死、软件已变」的漂移；
 * - 同一份实现同时供 Agent 工具（harness_help）与 CLI 命令（harness introspect）使用，单一事实来源。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PluginPermissions } from '@zhuxing/harness-kernel'

/** 可查询的本体知识话题。 */
export type SelfKnowledgeTopic = 'overview' | 'commands' | 'api' | 'paths' | 'plugins' | 'tools' | 'flows'

export const SELF_KNOWLEDGE_TOPICS: SelfKnowledgeTopic[] = [
  'overview',
  'commands',
  'api',
  'paths',
  'plugins',
  'tools',
  'flows',
]

/** 自省输入：运行时实时数据（版本自动读取；插件/工具由调用方从内核注册表取）。 */
export interface SelfKnowledgeInput {
  /** 工作区（项目根）绝对路径。 */
  workspace?: string
  /** 已挂载插件（名称 + 描述 + 声明的权限维度摘要）。 */
  plugins?: Array<{ id: string; description?: string; enabled?: boolean; permissions?: string[] }>
  /** 已注册工具（名称 + 描述）。 */
  tools?: Array<{ name: string; description?: string }>
}

/** 当前版本：优先安装根 VERSION（安装态），否则回退构建注入版本。 */
export function currentVersion(): string {
  const root = process.env.HARNESS_ROOT
  if (root) {
    try {
      const v = readFileSync(join(root, 'VERSION'), 'utf-8').trim()
      if (v) return v
    } catch {
      // 安装根尚无 VERSION（或不可读）时回退构建注入版本
    }
  }
  return (globalThis as { __HARNESS_VERSION__?: string }).__HARNESS_VERSION__ ?? 'unknown'
}

/**
 * 本体自身所在位置：安装态取 HARNESS_ROOT；源码开发仓从运行入口逐级上溯，找到含 pnpm-workspace.yaml 的目录。
 * 用途：让模型直接定位本体自身的代码/安装根，避免在工作区里找不到时对全盘做递归搜索。
 */
export function harnessRoot(): string | undefined {
  const root = process.env.HARNESS_ROOT
  if (root) return resolve(root)
  let dir = process.argv[1] ? dirname(resolve(process.argv[1])) : ''
  for (let i = 0; i < 6 && dir; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** CLI 命令面（以 harness help 的用法为准）。 */
const CLI_COMMANDS = `# CLI 命令（可执行文件 harness，全量帮助：harness help）
- run [选项] "任务" / dev [选项] "任务"：运行一次 Agent 任务 / 开发模式（监听插件变化自动重载重跑）
- login：交互式配置 API Key / 模型 / 工作区；config <get|set|list|rm> [key] [value]：查看或修改持久化配置
- session <ls|show|rm|archive|unarchive> [会话id]：会话管理；space <ls|add|rename|rm>：空间（项目）管理
- models <list|stats>：多子模型列表与实时性能；memory <list|add|rm|clear>：跨会话记忆
- skill <list|add|rm|show|run|create>：技能（提示词模板 + 工具子集，支持自有 YAML 与 Agent Skills 规范的 SKILL.md）；tools <list|test>：工具列表与试运行
- validate <插件路径> / create-plugin <名称> / install <插件目录> [--as <名称>] / list：插件校验、脚手架、安装、列出
- plugin-keygen [--out <私钥文件>] / plugin-sign <插件目录|入口文件> --key <私钥 PEM> / plugin-verify <插件目录|入口文件>：插件签名密钥生成、目录签名、独立校验
- web [--port <n>]：启动 Web UI（默认端口 3080）
- update [--check|--url <url>|--file <zip>]：应用内更新（检查 / 指定更新源 / 手动装本地包）
- doctor [--network]：环境自检（版本 / 配置 / 目录 / 端点）；completion <bash|zsh>：生成补全脚本
- version / -v、help：版本与帮助`

/** Web HTTP 端点面（服务默认监听 127.0.0.1，端口可配）。 */
const WEB_ENDPOINTS = `# Web API 端点（Web UI 后端，默认端口 3080）
- 健康与配置：GET /api/health、GET /api/bootstrap、GET|POST /api/config、GET /api/models、GET /api/token-plan/models
- 对话：POST /api/chat（标准回复）/ WebSocket（流式）
- 会话与空间：GET /api/sessions、GET /api/sessions/<id>/events、PATCH|DELETE /api/sessions/<id>、
  POST /api/sessions/<id>/archive|unarchive|fork|merge、GET|POST /api/spaces、PATCH|DELETE /api/spaces/<id>
- 文件与工作区：GET /api/files/preview、POST /api/files/upload、POST /api/workspace/pick、POST /api/workspace/temp
- 记忆：GET|POST /api/memory、POST /api/memory/clear、DELETE /api/memory/<id>
- 知识库：GET /api/knowledge、POST /api/knowledge/upload|ask|clear|reindex、GET|POST /api/knowledge/spaces、
  GET /api/knowledge/spaces/<id>/folders、POST /api/knowledge/spaces/<id>/folders、PATCH|DELETE /api/knowledge/spaces/<id>、
  PATCH|DELETE /api/knowledge/folders/<id>、PATCH|DELETE /api/knowledge/docs/<id>、PATCH /api/knowledge/<id>/move
- 技能与专业化包：GET|POST /api/skills、GET|DELETE /api/skills/<name>、POST /api/skills/<name>/run、
  POST /api/skills/upload|install、GET /api/specs、POST /api/specs/install、POST /api/specs/<id>/enable|disable、DELETE /api/specs/<id>
- 工具与更新：GET /api/tools、POST /api/tools/<name>/test、GET /api/update/check、POST /api/update、
  POST /api/update/install、GET /api/update/status`

/** 内置流程（需要时才取的操作性知识）。 */
const FLOWS = `# 内置流程
## 内核自更新
1. 更新源：自建 HTTP 静态目录（含 manifest.json 与增量包 zip）；解析优先级 --url 参数 > 环境变量 HARNESS_UPDATE_URL >
   配置文件（~/.zhuxing-harness/config.json）的 updateUrl；三处都没有时先向用户要更新源地址，不编造。
2. 检查更新：harness update --check（对比当前版本与 manifest 的 latestVersion）；Web 端等价入口 GET /api/update/check。
3. 执行更新：远程更新用 harness update（下载包后按 manifest 的 sha256 校验，不匹配即拒绝安装）；用户给的是本地 zip 时用
   harness update --file <zip>；Web 端等价入口 POST /api/update 与 POST /api/update/install（base64 上传 zip）；
   面向用户的图形入口是 Web UI 设置中的「更新」面板（检查更新 / 立即更新 / 安装本地包）。
4. 热/冷两条路径：包内只含 bin/kernel.mjs 的是内核热更新——不停服，替换后立即自检（kernelSelfTest），
   失败自动从备份恢复并回滚；含 bin/harness.cjs 的是冷更新——停服、备份到 <HARNESS_ROOT>/backups/<旧版本>/、覆盖后重启服务。
5. 结果核对：更新后读 <HARNESS_ROOT>/update-status.json（success / rolled-back / failed，含 fromVersion、toVersion、changelog）
   或 GET /api/update/status，按状态如实汇报；当前版本看 <HARNESS_ROOT>/VERSION，变更说明看 <HARNESS_ROOT>/kernel-changelog.md。
6. 发布新版（开发侧）：在源码仓库执行 node scripts/build-update.mjs 产完整包，或设置 HARNESS_UPDATE_KERNEL_ONLY=1 后执行
   产仅内核热更新包，产物在 dist-update/（zip + manifest.json），部署到更新源目录即对用户可用。
7. 工具清单里没有 update 工具不代表不能自更新：按上述入口用 shell 或 Web API 完成；更新会改变运行环境，
   执行前须获得用户明确同意，失败或被回滚时不隐瞒。
## 其余流程
- 重复性流程编译为 G-code 模板（一次编译、多次执行）、记忆沉淀、子模型委派等行为原则常驻在系统提示词中，无需查询。`

/**
 * MCP（接入外部工具）的事实与风险。措辞必须准确——这里的三条是「本方案管不住什么」的如实交代，
 * 不能淡化：沙箱管不到外部进程里的文件访问，能力并入即信任转移。
 */
const MCP_CLIENT = `# MCP（Model Context Protocol，接入外部工具）
- 配置 \`mcpServers\`（与 Claude Desktop / Cursor 同形状：\`{ "<server>": { command, args?, env?, cwd? } }\`）后，
  每个 server 以**子进程**方式被拉起，其工具注册为 \`mcp__<server>__<tool>\`；工具调用结果有 64KB 截断上限。
- **接入某个 MCP server 等于把它的能力并入你的 agent**：server 是第三方代码，在**外部进程**里执行，其行为不由本软件控制。
- **本软件的路径沙箱管不住它碰什么文件**：沙箱是「工具元数据 + 路径前缀校验」，只约束经本工具注册表、且带 sandbox 参数语义的调用
  （\`args[readArg]\` / \`args[writeArg]\` / \`args[commandArg]\`）；MCP 工具没有这类参数语义，其真实文件访问发生在**我们看不到的进程**里。
- 因此**只接入你信任的 server**；\`command: "npx"\` / \`uvx\` 这类写法是「联网拉取即执行」，意味着**每次可能执行不同版本的代码**。
- 客户端在协议上如实声明空能力（不提供 roots / sampling / elicitation）；协议版本为双版本协商：现代 \`2026-07-28\`
  （\`server/discover\` 探测 + 每请求 \`_meta\` 内联版本与能力）与旧版 \`2025-06-18\`（\`initialize\` 握手 + \`notifications/initialized\`）；
  服务端回了其它版本则**断开**（不硬跑）。stdio 不走 MCP 授权框架，凭据从环境变量取。`

/** 运行时身份行：版本 / 运行形态 / 平台 / 工作区。 */
function runtimeSection(input: SelfKnowledgeInput): string {
  const root = process.env.HARNESS_ROOT
  const lines = [
    `- 版本：v${currentVersion()}；运行形态：${root ? `安装态（HARNESS_ROOT=${root}）` : '源码开发仓（无 HARNESS_ROOT）'}；平台：${process.platform}`,
  ]
  const located = harnessRoot()
  if (!root && located) {
    lines.push(`- 本体源码：${located}（本体自身代码，通常在工作区之外；问及本体实现时直接在此定位，勿全盘搜索）`)
  }
  if (input.workspace) lines.push(`- 工作区（项目根，工具相对路径以此为基准）：${input.workspace}`)
  return lines.join('\n')
}

/** 配置与数据路径节。 */
function pathsSection(): string {
  const root = process.env.HARNESS_ROOT
  const home = '~/.zhuxing-harness'
  const lines = [
    `- 用户配置：${process.env.HARNESS_CONFIG ?? `${home}/config.json`}（harness config 系列命令读写）`,
    `- 会话：${process.env.HARNESS_SESSION_DIR ?? `${home}/sessions/`}；记忆：${home}/memories.json；G-code 模板：与记忆同目录 gcode-templates.json`,
    `- 技能：${home}/skills/（全局）与 <工作区>/.harness/skills/（项目级）；两种格式都识别：<名称>.yaml（自有模板，本地优先）` +
      `与 <名称>/SKILL.md（Agent Skills 规范：YAML frontmatter 需含 name/description，正文即提示词）；知识库索引：${home}/knowledge/index.json`,
  ]
  if (root) {
    lines.push(
      `- 安装根 HARNESS_ROOT：${root}；版本文件：${root}/VERSION；更新状态：${root}/update-status.json；` +
        `变更说明：${root}/kernel-changelog.md；冷更新备份：${root}/backups/<旧版本>/`,
    )
  } else {
    lines.push('- 安装根：当前为源码开发仓（无 HARNESS_ROOT），自更新仅在安装态可用。')
  }
  return `# 本体路径\n${lines.join('\n')}`
}

/** 把插件声明的权限维度压成简短摘要（供自省展示，如 `fsWrite: /tmp/x`）；未声明返回空数组。 */
export function summarizePluginPermissions(permissions?: PluginPermissions): string[] {
  if (!permissions) return []
  const out: string[] = []
  const push = (dimension: string, values?: string[]) => {
    if (values) out.push(`${dimension}: ${values.length > 0 ? values.join(', ') : '(空，等价于全部拒绝)'}`)
  }
  push('fsRead', permissions.fsRead)
  push('fsWrite', permissions.fsWrite)
  push('shell', permissions.shell)
  push('net', permissions.net)
  push('env', permissions.env)
  return out
}

/**
 * 插件供应链治理的事实：权限清单 + 签名校验。
 *
 * 这两件事的强度**不同**，必须分开表述：签名校验是真安全边界（加载前拒绝）；权限清单是治理与审计，
 * **经由 harness 边界生效、不是进程隔离**——插件是进程内任意 JS，可直接调用 Node API 绕过。
 */
const PLUGIN_GOVERNANCE = `# 插件权限与签名（供应链治理）
- 权限清单：插件定义可选声明 permissions（fsRead / fsWrite / shell / net / env）。强制点只有一个——**经工具注册表执行的工具调用参数**：
  args[writeArg] 必须落在 fsWrite、args[readArg] 落在 fsRead、args[commandArg] 的命令首词属于 shell；越界即拒绝执行（返回可读原因），
  并以 tools/after-exec 事件（rejectedBy=plugin-permissions，含 pluginId）留痕。net / env 目前仅声明、无强制点（工具元数据没有 host / 环境变量语义）。
- 能力边界：**权限经由 harness 边界生效，不是进程隔离**。插件是进程内任意 JS 代码，可直接 import('node:fs') / child_process 绕过上述检查；
  未声明 permissions 的插件、以及未声明的维度都不设限。它是治理与审计手段，不是沙箱。
- 签名校验（真边界，ed25519，加载前 fail-closed）：信任根 keyring 优先级 HARNESS_PLUGIN_KEYRING > 配置 plugins.trustedKeys，
  条目形如 <别名>:<公钥>；签名覆盖插件目录全部参与文件（排除 node_modules/.git/dist/.harness-cache、*.map/*.tsbuildinfo 与 .harness-signature.json）。
  配了 keyring：未签名 / 公钥不可信 / 签名无效 / 内容与签名不符 → 拒绝加载或安装；未配置 keyring：保持既有行为（允许加载）但提示「插件签名未校验」。
- 命令：harness plugin-keygen → harness plugin-sign <插件目录> --key <私钥 PEM> → harness plugin-verify <插件目录>。`

/** 插件清单节（未提供实时数据时提示获取方式）。 */
function pluginsSection(input: SelfKnowledgeInput): string {
  if (!input.plugins || input.plugins.length === 0) {
    return `# 已装插件\n（未取到运行时插件清单；可用 harness list 查看配置解析出的插件）\n${PLUGIN_GOVERNANCE}\n${MCP_CLIENT}`
  }
  const lines = input.plugins.map(
    (p) =>
      `- ${p.id}${p.enabled === false ? '（停用）' : ''}${p.description ? `：${p.description}` : ''}` +
      `${p.permissions && p.permissions.length > 0 ? `［permissions：${p.permissions.join('；')}］` : ''}`,
  )
  return `# 已装插件（${input.plugins.length} 个，运行时挂载实况）\n${lines.join('\n')}\n${PLUGIN_GOVERNANCE}\n${MCP_CLIENT}`
}

/** 工具清单节（未提供实时数据时提示获取方式）。 */
function toolsSection(input: SelfKnowledgeInput): string {
  if (!input.tools || input.tools.length === 0) {
    return '# 可用工具\n（未取到运行时工具清单；可用 harness tools list 查看）'
  }
  const lines = input.tools.map((t) => `- ${t.name}：${t.description}`)
  return `# 可用工具（${input.tools.length} 个，运行时注册实况）\n${lines.join('\n')}`
}

/**
 * 渲染本体知识：按话题返回紧凑文本，供 Agent 工具（harness_help）与 CLI 命令（harness introspect）共用。
 * 未知话题不抛错，返回总览并提示可用话题。
 */
export function renderSelfKnowledge(topic: string = 'overview', input: SelfKnowledgeInput = {}): string {
  switch (topic) {
    case 'commands':
      return CLI_COMMANDS
    case 'api':
      return WEB_ENDPOINTS
    case 'paths':
      return pathsSection()
    case 'plugins':
      return pluginsSection(input)
    case 'tools':
      return toolsSection(input)
    case 'flows':
      return FLOWS
    case 'overview':
      return [
        `# 筑星 Harness 本体（Zhuxing Harness v${currentVersion()}）`,
        runtimeSection(input),
        '- 形态：以插件为核心的内核（插件宿主 / 服务注册 / 事件总线）+ 基础 bundle（沙箱 / 会话 / 工具 / 模型 / Agent 循环）+ Web UI',
        '- 遥测（OpenTelemetry GenAI 语义约定，该约定目前处于 Development 阶段、属性名可能演进）：**默认关闭**——未配置端点时遥测插件不注册监听器、不起定时器、不发起任何网络请求；' +
          '设置环境变量 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（信号级端点，按原样使用）或 `OTEL_EXPORTER_OTLP_ENDPOINT`（基础端点，自动补 `/v1/traces`）后，' +
          '插件以 OTLP/JSON 批量 POST 导出 trace（`service.name` 取 `OTEL_SERVICE_NAME`，缺省 `zhuxing-harness`），插件卸载时 flush。' +
          '当前导出的 span 为 `execute_tool <工具名>`（`gen_ai.operation.name=execute_tool`、`gen_ai.tool.name`、`gen_ai.tool.type`、`gen_ai.agent.name`、失败时 `error.type`、可用时 `gen_ai.conversation.id`）。',
        '- 遥测隐私：span **默认不含**提示词 / 回复 / 工具参数与结果正文；只有显式设置 `OTEL_GENAI_CAPTURE_CONTENT=1` 才采集这几类正文属性，' +
          '且采集前先经凭据脱敏——开启即表示接受「把用户内容发往该 collector」。',
        MCP_CLIENT,
        `- 知识话题（harness_help 的 topic 参数 / harness introspect <topic>）：${SELF_KNOWLEDGE_TOPICS.join(' | ')}`,
      ].join('\n')
    default:
      return [
        `未知话题「${topic}」。可用话题：${SELF_KNOWLEDGE_TOPICS.join(' | ')}`,
        '',
        renderSelfKnowledge('overview', input),
      ].join('\n')
  }
}
