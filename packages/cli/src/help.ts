import { DEFAULT_PERMISSION_LEVEL, PERMISSION_LEVELS } from '@zhuxing/harness-sandbox'

export const HELP = `筑星 Harness CLI

用法：
  harness run [选项] "任务描述"      运行一次 Agent 任务（实时显示进度）
  harness dev [选项] "任务描述"      开发模式：监听插件变化，自动重载并重跑
  harness login                    交互式配置 API Key / 模型 / 工作区（持久化）
  harness config <get|set|list|rm> 查看/修改持久化配置
  harness session <ls|show|rm|archive|unarchive> 会话管理（基于 ~/.zhuxing-harness/sessions）
  harness space <ls|add|rename|rm>  空间（项目）管理，隔离不同主题的会话
  harness models <list|stats>      多子模型管理（列表 / 实时性能指标）
  harness memory <list|add|rm|clear> 跨会话记忆管理（用户偏好 / 项目上下文）
  harness skill <list|add|rm|show|run|create> 技能管理（提示词模板 + 工具子集）
  harness tools <list|test>         工具管理（列表 / 试运行）
  harness validate <插件路径>       校验插件定义
  harness create-plugin <名称>      生成插件脚手架
  harness install <插件目录> [--as <名称>]  安装本地插件到 plugins/（配了信任公钥时先校验签名）
  harness plugin-keygen [--out <私钥文件>] [--name <别名>]  生成 ed25519 插件签名密钥对（私钥 0600 落盘）
  harness plugin-sign <插件目录|入口文件> --key <私钥 PEM>   对插件目录签名（写 .harness-signature.json）
  harness plugin-verify <插件目录|入口文件>                 按信任清单独立校验插件签名
  harness list [选项]              列出配置解析出的插件
  harness introspect [话题]        本体自省：版本/路径/CLI 命令/Web 端点/插件/工具/内置流程（--json 结构化）
  harness web [--port <n>]        启动 Web UI（对话/工作/交付，默认端口 3080）
  harness update [选项]           应用内更新：检查 / 下载 / 手动安装增量包
  harness doctor [--network]       环境自检（版本/配置/目录/端点）
  harness completion [bash|zsh]    生成 shell 补全脚本
  harness version / -v             显示版本
  harness help                     显示帮助

update 选项：
      --check            仅检查是否有新版本，不下载
      --url <url>        指定更新源（默认：HARNESS_UPDATE_URL / config.updateUrl）
      --file <zip>       手动安装本地增量包

插件签名（供应链治理，ed25519）：
  信任清单来源（优先级）：环境变量 HARNESS_PLUGIN_KEYRING > 配置 plugins.trustedKeys
  条目格式：<别名>:<公钥> 或 <公钥>（ed25519 裸公钥 base64），多个条目用逗号/空白分隔
  · 配了信任清单：从文件加载或安装的插件必须签名校验通过，否则拒绝加载/安装（fail-closed）
  · 未配置：保持既有行为（允许），但会提示「插件签名未校验（未配置信任公钥）」
  · 签名覆盖插件目录全部参与文件（排除 node_modules/.git/dist/.harness-cache、*.map/*.tsbuildinfo 与签名文件自身）
  · 注意：签名校验是真边界（加载前拒绝）；插件权限清单（permissions）只治理经 harness 边界的工具调用，不是隔离
  用法：harness plugin-keygen → harness plugin-sign <插件目录> --key <私钥 PEM> → harness plugin-verify <插件目录>

run / dev 选项：
  -p, --patch <文件>        patch 覆盖层（可多次）
      --profile <文件>      profile 组合文件
      --api-key <key>       API Key（默认：配置 / 环境变量）
      --base-url <url>      OpenAI 兼容端点（默认 https://api.deepseek.com/v1）
      --model <name>        模型名（默认 deepseek-v4-flash）
  -w, --workspace <目录>    工作区（默认：配置或当前目录）
      --level <级别>        沙箱级别：${PERMISSION_LEVELS.join(' | ')}（默认 ${DEFAULT_PERMISSION_LEVEL}）
      --max-steps <n>       Agent 最大步数（默认 70，复杂任务可调高）
      --temperature <t>     采样温度
      --system-prompt <s>   系统提示
      --session-dir <目录>  会话持久化目录（默认 ~/.zhuxing-harness/sessions）
      --stream              逐 token 流式输出模型回答
      --json                输出结构化 JSON（用于脚本）
      --summary             最终输出折叠为交付摘要（完整数据在会话日志）
      --timing              打印各阶段耗时
      --verbose             打印完整会话轨迹
      --log-level <l>       日志级别：trace|debug|info|warn|error
      --models <json>       多子模型配置（JSON 数组，覆盖 config.models）
      --model-id <id>       显式指定子模型（跳过自动选择）

示例：
  harness run "总结这个仓库的包结构"
  harness run --stream "解释一下什么是 Agent harness"
  harness dev -p my-plugin.yml "执行插件提供的工具"
  harness session ls
  harness models list
`
