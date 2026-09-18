# 筑星 Harness（Zhuxing Harness）

> **插件优先内核 · 开放工具生态 · 签名可治理 · 知识自生长**
> 一个内核零业务逻辑的国产开源 Agent 运行时：包括工具生态在内的每一项能力，都以插件形式挂载。

[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](./CHANGELOG.zh-CN.md)
[![License](https://img.shields.io/badge/license-Source--Available%20%2F%20Commercial-9c27b0.svg)](#许可)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-0078d4.svg)](#安装)
![Status](https://img.shields.io/badge/status-Active%20Development-brightgreen.svg)

> English version: [README.md](README.md) · 英文版请见 [README.md](README.md)。

---

## 目录

- [一句话理解](#一句话理解)
- [为什么这样设计](#为什么这样设计)
- [核心能力](#核心能力)
  - [1. 插件优先内核：内核不做业务](#1-插件优先内核内核不做业务)
  - [2. 开放工具生态：内置 MCP 客户端](#2-开放工具生态内置-mcp-客户端)
  - [3. 信任：权限清单与 ed25519 签名](#3-信任权限清单与-ed25519-签名)
  - [4. 三层权限沙箱](#4-三层权限沙箱)
  - [5. 模型无关，并支持多子模型路由](#5-模型无关并支持多子模型路由)
  - [6. 经验会复利：记忆 · 知识 · 技能](#6-经验会复利记忆--知识--技能)
  - [7. 交付：从「回答问题」到「交付产物」](#7-交付从回答问题到交付产物)
  - [8. 可观测性：OpenTelemetry GenAI 遥测](#8-可观测性opentelemetry-genai-遥测)
- [架构概览](#架构概览)
- [快速开始](#快速开始)
  - [安装](#安装)
  - [配置模型](#配置模型)
  - [接入 MCP 服务器](#接入-mcp-服务器)
  - [启动 Web UI](#启动-web-ui)
- [写一个插件](#写一个插件)
- [一个完整的端到端示例](#一个完整的端到端示例)
- [与同类项目的差异](#与同类项目的差异)
- [应用场景（多行业）](#应用场景多行业)
- [命令总览](#命令总览)
- [文档](#文档)
- [许可](#许可)

---

## 一句话理解

**筑星 Harness 不是「又一个 Claude Code 的中文版」，也不是一套 prompt 模板。**

它是一个只建立在一条规则上的 Agent 运行时：**插件是唯一原语。**

- **内核无特权**：`kernel` 只提供 `Context`、生命周期、依赖注入与事件总线，不含任何 Agent 业务逻辑；
- **能力全部可替换**：模型、工具、会话、沙箱、记忆、知识、技能、Agent 循环、CLI 输出——全都是插件；任何一层都能通过 `profile` / `patch` 配置替换或扩展，无需改动内核；
- **开放生态**：内置 MCP 客户端（stdio 传输、双时代协议协商），不写一行插件代码就能用上更广阔的 MCP 工具生态；
- **可治理而非仅靠信任**：插件可以声明自己需要的权限，插件目录可以做 ed25519 签名；配置了信任清单后，签名校验是 fail-closed 的；
- **会复利**：文档变成可检索、可溯源的知识；跑通的流程固化成可复用的技能；跨会话的经验沉淀为记忆。

> 如果说传统 Agent 框架是「给 AI 一套工具箱」，那么筑星 Harness 的目标是：**让 AI 在使用中自己把工具箱越做越大、越用越顺手。**

---

## 为什么这样设计

| 行业痛点 | 筑星的回答 |
|----------|-----------|
| Agent 框架把业务逻辑写死在内核，难以定制 | 内核无特权，能力=插件，通过 `profile` / `patch` 分层配置即可替换或扩展任意一层 |
| 工具生态是封闭的，每接一个集成都得写一份定制代码 | 内置 **MCP 客户端**：指向任意 stdio MCP 服务器，它的工具立刻成为 Agent 的工具 |
| 装第三方插件等于把机器交出去，且没有审查路径 | 插件可声明**权限清单**，可做 **ed25519 签名**；配置信任清单后校验 fail-closed |
| 主流 Agent 深度绑定海外模型与账号，国内企业难以落地 | 模型完全可插拔，用户自填 Key / BaseURL，兼容任意 OpenAI 协议端点（百炼 / 千问 / DeepSeek 等） |
| 权限失控、无法追溯，企业不敢用 | `read-only` / `workspace-write` / `danger-full-access` 三层隔离；每一次工具调用都留在会话事件日志里 |
| 知识库只是「文档问答」，用完即弃 | 自生长知识库 + 语义检索 + 溯源标注 |
| Agent 每次都从零推理，越用越累 | 工作流沉淀为 Skill、经验落成记忆，下次同类任务直接复用 |
| 看不出 Agent 到底做了什么、花了多少 | 每次 LLM 调用都有 **OTel GenAI** span（可选开启），事件总线上另有 `agent/llm-*` 事件 |

---

## 核心能力

### 1. 插件优先内核：内核不做业务

筑星最根本的设计原则：**插件是唯一原语，内核是零特权的。**

插件能用的 `Context` 接口只有这些：

| 接口 | 语义 |
|-----|------|
| `provide(name, impl)` | 注册（或覆盖）一个服务 |
| `inject(name)` | 取一个服务；不存在即抛错 |
| `injectOptional(name)` | 取一个服务，不存在返回 `undefined` |
| `effect(disposer)` | 登记可逆副作用，卸载时逆序执行 |
| `on` / `once` / `emit` | 订阅 / 一次性订阅 / 派发事件；卸载时自动摘除监听器 |
| `track(promise)` | 登记 in-flight 任务，卸载时可等待其收尾 |

在此之上，插件管理器负责那些真正麻烦的部分：依赖没就绪的插件先挂为 *pending*；卸载一个插件会**级联卸载**它的消费方；**循环依赖会被检测出来**；`dispose` 会先逆序跑完 effects，再等待 in-flight 任务。

落到实际规模上：**19 个包**之间只靠服务和事件咬合，不存在插件无法替换的特权「内核」。默认运行时装配了分布在 11 个域文件里的 **15 个插件**，每个都声明了自己注入什么、提供什么。

### 2. 开放工具生态：内置 MCP 客户端

与其要求你为每一个集成手写插件，筑星直接讲 **MCP（Model Context Protocol）**——任何 MCP 服务器的工具，都能变成 Agent 的工具。

**传输与协议——如实说清：**

- **只支持 stdio**。HTTP / SSE 的 MCP 服务器会被显式识别、给出告警并跳过，不会被静默忽略；
- **双时代协商**。客户端先发 `server/discover`：对端认识它，就按**现代协议（`2026-07-28`）**处理——现代协议是无状态的，**没有 `initialize` 握手**，版本与能力内联在每个请求的 `_meta` 里；否则回落到**旧版协议（`2025-06-18`）的 `initialize`** 握手，随后发 `notifications/initialized`；
- **保留错误码不是回落信号**。如果服务端返回协议保留区间（`-32020`…`-32099`）的错误，客户端**不会**回落——该区间说明对端是现代的，其中 `-32022` 表示「不支持该版本」，此时客户端断开连接，而不是靠猜继续。

**暴露给模型的能力**：只有工具。本客户端实现的是 `tools/list` 与 `tools/call`；`resources/*`、`prompts/*`、`sampling`、`roots`、`elicitation` 均**未实现**，能力声明如实为空。服务端发起的反向请求会被拒绝，而不是给一个半成品答复。

**命名与安全**：MCP 工具注册为 `mcp__<服务器名>__<工具名>`（服务器名不允许含 `__`，以保证映射无歧义）；结果默认按 64KB 截断，避免某个话多的服务器把上下文撑爆。

**配置方式**：在 `~/.zhuxing-harness/config.json` 的 `mcpServers` 下声明。若没有 `mcpServers`，MCP 插件**根本不会被注册**——对既有配置零行为变化。每个服务器还可配 `args`、`env`、`cwd`、`disabled`，以及初始化 / 列举 / 调用各自的超时。

### 3. 信任：权限清单与 ed25519 签名

工具生态开放之后，能管住「装进来的东西」才有意义。筑星提供两道机制，并且明确说清各自管什么、不管什么。

**权限清单（治理）。** 插件可以声明 `fsRead` / `fsWrite` / `shell` / `net` / `env`。清单在**工具执行边界**强制：在 `ToolRegistry.execute` 内部，先校验插件权限，再由沙箱裁决；越界会返回可读的错误，同时在 `tools/after-exec` 留下一条标记为 `rejectedBy: 'plugin-permissions'` 的记录，并带上违规插件的 id。

把边界说准确：这是**治理，不是隔离**。`fsRead` / `fsWrite` / `shell` 在工具路径上被检查；`net` 与 `env` 目前只做声明，没有强制点。一个以 Node 模块身份运行的恶意插件，仍然可以直接 `import('node:fs')` 绕过整个清单。清单的意义是让插件的意图变得显式、可审计——不是把任意代码关进沙箱。

**ed25519 目录签名（真正的边界）。** 插件目录可以签名：逐文件算哈希，把每文件的摘要拼成清单再哈希一次，得到目录摘要，最后用 ed25519 对它签名。`node_modules`、`.git`、`dist`、`.harness-cache` 与签名文件自身被排除，`.map` 与 `*.tsbuildinfo` 也被排除——否则重新构建一次就会被误判为篡改。

一旦你配置了信任清单（环境变量 `HARNESS_PLUGIN_KEYRING`，或配置里的 `plugins.trustedKeys`），校验就是 **fail-closed** 的：未签名的、签了但公钥不在清单里的、格式不对的、内容与签名已不符的插件，一律**在加载前被拒绝**。未配置信任清单时插件仍能加载，但会明确提示「未校验」。

日常使用只需要三条命令：`harness plugin-keygen`、`harness plugin-sign`、`harness plugin-verify`。

### 4. 三层权限沙箱

| 层级 | 能力 | 典型操作 |
|------|------|---------|
| **`read-only`** | 仅观察，零副作用 | 读文件、列目录、检索知识库 |
| **`workspace-write`**（默认） | 受限执行，仅允许工作区内写入 | 生成文件、跑脚本、写产物 |
| **`danger-full-access`** | 完整本机控制 | 任意命令、网外访问（需明确授权） |

设计要点：

- 每一条命令、每一次写入都由 `Sandbox.checkCommand` / `checkWrite` 裁决。命令裁决有明确顺序：先看显式 `deniedCommands`，再看 `danger-full-access` 是否直接放行，然后看 `allowedCommands` 白名单，最后才落到写意图黑名单；
- 黑名单覆盖破坏性文件动词（`rm` / `mv` / `cp` / `mkdir` / `remove-item` / `set-content` …）、输出重定向、原地 `sed -i`、交互式编辑器、权限变更（`chmod` / `icacls` …）、VCS 写操作（`git push` / `commit` / `reset` / `clean` …）、包管理器的安装与发布，以及 `curl -o` / `wget` / `dd` / `mkfs`。shell 包装器（`sh -c`、`cmd /c`、`powershell -c`、`env`）会被逐层剥离（最多三层），裁决的是内层真命令而不是包装器；
- **凭据类文件在任何层级都不可读**。`checkRead` 无视权限等级直接拒绝 `.env`、`secrets.*`、`id_rsa` 之类，以及 `.git-credentials`、`.netrc`、`credentials.*`；
- 工具通过 `sandbox: { commandArg, writeArg }` 声明哪个参数需要被守卫；
- `workspace-write` 的边界用路径归一化 + 符号链接 `realpath` + 分隔符感知的比对来判定，而不是朴素的字符串前缀比较；
- Agent 不能自行提升权限，更不能修改权限层本身。

### 5. 模型无关，并支持多子模型路由

**模型是插件，不是地基。**

- 用户自行填写 **API Key** 与 **API Base URL**，不强制任何厂商；
- 基于统一的 OpenAI 兼容协议实现 `OpenAICompatibleProvider`，已内置对百炼 / 千问、DeepSeek 等端点的支持；
- `Provider` 抽象层清晰，接入新厂商只需实现一个 `ChatProvider`；
- 上层 Agent 循环、技能、知识库、权限系统完全不感知具体模型。

> 用户可以在不通 OpenAI、不通 Anthropic 的纯内网环境下，用国产模型把整套 Agent 跑起来。这是「模型主权」在代码层面的真实落地。

当一个模型不够用时，随包提供的 `model-router` 插件在此之上加了治理：

- **注册表**：热插拔地注册 / 注销子模型；
- **监控**：滑动窗口记录每个模型的延迟、成功率、token、成本；
- **选择器**：按意图关键词命中、上下文长度与实时表现加权打分，挑出最合适的那个；
- **路由与降级**：首选失败自动切备用模型，并且对外输出格式统一；
- **编排**：主编排模型经 `pick_model` / `list_models` 工具把子任务委派给子模型。

### 6. 经验会复利：记忆 · 知识 · 技能

**知识库**——从「问答」到「可溯源的语料」：

- 上传文档后自动**分块**（段落感知，默认 800 字、重叠 120），支持纯文本 / docx / pptx / xlsx；
- 配置 Embedding（OpenAI 兼容 `/embeddings`）后启用**语义检索（RAG）**，未配置时自动降级为关键词匹配（CJK 二元组 + 拉丁词元）；
- 支持**多空间 / 目录树 / 作用域**管理与重索引；
- 命中内容注入每次对话的 system prompt（默认 8KB 上限，防止上下文投毒）；
- 问答**带溯源**：命中内容标注来源，可回溯到原文词条。

**技能（Skill）**——把「怎么做」外化为可读、可管、可版本化的文件：

- 技能 = 提示词模板（`{{param}}` 占位）+ 输入参数 JSON Schema + 可选工具子集 + 记忆绑定；
- 以 YAML 落盘，可解释、可审计、可导出、可导入；并且自 0.4.0 起兼容 Agent Skills 的 `SKILL.md` 规范（`<技能名>/SKILL.md` 带 YAML frontmatter），上传时也支持 `.md` 文件或 zip 内的 `SKILL.md`；
- 支持 RAG 式检索调用，也支持经验式复用；技能之间可组合、可并行；
- 配套 CLI：`harness skill list/add/rm/show/run/create`，以及 `use_skill` / `list_skills` 工具。

**记忆（Memory）**——把「跨会话的经验」沉淀下来：

- 作用域：`user` / `project` / `auto` / `session`；
- 每次 Agent 运行前自动注入跨会话记忆与本次会话私有记忆（默认 4KB 截断）。

> 这相当于给 Agent 装上了**长期记忆 + 肌肉记忆**：不靠无限拉长上下文，而是把经验外化到磁盘，需要时再加载。

### 7. 交付：从「回答问题」到「交付产物」

筑星不是「在对话框里给你一段文字」，而是**走完一个真实工作流并交付文件**：

- 读取 / 检索本机文件与项目状态（`read_file` / `list_dir`）；
- 调用生成脚本、执行构建（`shell`，经沙箱裁决）；
- 生成 **图片 / 视频 / 语音（TTS）/ 代码 / 脚本** 等真实产物（`generate_image` / `generate_video` / `text_to_speech`）；
- 将产物写入指定目录，并回报完整路径与复跑命令。

### 8. 可观测性：OpenTelemetry GenAI 遥测

你应当看得见 Agent 到底做了什么——但在你不关心的时候，不该为此付出任何代价。

- **默认关闭**。未配置端点时，`harness-telemetry` 插件直接返回：不注册监听器、不起定时器、不产生任何网络流量；
- **基于标准导出**。设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_ENDPOINT`，后者会自动补 `/v1/traces`）后，span 批量以 **OTLP/JSON over HTTP** 导出——不引入厂商 SDK，也不引入任何遥测依赖。服务名取自 `OTEL_SERVICE_NAME`；
- **遵循 GenAI 语义约定**。span 遵循 OpenTelemetry 的 GenAI 约定（注意：该规范目前仍处于 *Development* 状态，筑星按其现状跟进）；
- **正文采集可选，且先脱敏**。`OTEL_GENAI_CAPTURE_CONTENT` 决定是否带上 prompt 与响应正文；开启时正文会先过一遍凭据脱敏；
- **span 之下还有内核事件**。Agent 循环会派发 `agent/llm-request`（`sessionId`、`step`、`model?`）、`agent/llm-response`（另含 `responseModel?`、`usage?`、`finishReasons`、`latencyMs`）与 `agent/llm-error`（另含 `errorType`、`message`、`latencyMs`），因此你不采用 OTLP，也可以直接基于事件总线搭自己的看板。

---

## 架构概览

```
┌────────────────────────────────────────────────────────────────┐
│                     筑星 Harness 运行时                          │
├────────────────────────────────────────────────────────────────┤
│  CLI / Web UI / 桌面端          （命令入口 · 对话 · 交付）        │
│         │                                                       │
│         ▼                                                       │
│  插件管理器       provide · inject · effect · mount/unmount      │
│         │         依赖挂起 · 级联卸载 · 环依赖检测                │
│         ▼                                                       │
│  Agent 主循环                  turn/step 编排                    │
│         │                                                       │
│  增强链         memory → 会话上下文 → 知识库 RAG → skill          │
│         │                                                       │
│  工具执行管道   before-exec → 插件权限清单 → 沙箱裁决 → …         │
│         │                    → 超时重试 → after-exec             │
│         ▼                                                       │
│  工具来源              内置工具 · 你的插件 · MCP 服务器           │
│         │                                                       │
│  模型层                OpenAI 兼容 Provider（可插拔、可路由）      │
│         │                                                       │
│  本机环境                文件系统 · 工作区 · 脚本                 │
│                                                                 │
│  横切关注点：   权限沙箱 · 插件签名 · OpenTelemetry               │
└────────────────────────────────────────────────────────────────┘
```

关键设计原则：

1. **内核无特权**：Context / 生命周期 / DI / 事件，不含业务逻辑；
2. **插件即能力**：模型、工具、会话、沙箱、记忆、知识、技能、循环全为插件，可替换；
3. **工具生态开放但受控**：用 MCP 换触达，用权限清单与签名换控制；
4. **权限是横切关注点**，贯穿每一次工具调用；
5. **知识 / 技能 / 记忆是经验的外化**，可版本化、可导出、可分享。

---

## 快速开始

### 安装

从源码运行：

```bash
pnpm install
pnpm build
node packages/cli/dist/cli.js doctor      # 环境自检
```

Windows 安装包由 `node scripts/build-nsis.mjs` 生成（免管理员、装到 `%LOCALAPPDATA%\ZhuxingHarness`、内置便携 Node 运行时、开始菜单快捷方式与卸载器）。

### 配置模型

```bash
harness login                              # 一次性，交互式填写 API Key 与 Base URL
harness run "总结当前目录的结构"
```

任意 OpenAI 兼容端点都可以——百炼 / 千问、DeepSeek、本地网关，或你自己跑的任何服务。

### 接入 MCP 服务器

在 `~/.zhuxing-harness/config.json` 里加 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/expose"]
    }
  }
}
```

服务端声明了哪些工具，就会以 `mcp__filesystem__<工具名>` 注册进来，Agent 立刻可以调用。`harness introspect` 会挂载同一套 bundle，列出每个插件、它声明的权限，以及全部已注册工具——包括由 MCP 服务器贡献的那些。把 `mcpServers` 整个删掉，MCP 插件就不会被挂载。

### 启动 Web UI

```bash
harness web                                # 默认 http://127.0.0.1:3080
```

> 建议先在 `read-only` 或 `workspace-write` 层级跑，熟悉之后再按需开放权限。

---

## 写一个插件

插件就是一个接收 `Context` 的模块。没有基类要继承，也没有注册样板——声明你需要什么、提供什么，把必须回滚的副作用登记好：

```ts
export default {
  name: 'my-plugin',
  inject: ['tools'],
  provides: ['myService'],
  apply(ctx) {
    ctx.provide('myService', myServiceImpl)
    ctx.inject('tools').register(myTool)
    ctx.effect(() => myTool.dispose())      // 卸载时逆序执行
  },
}
```

然后用 `profile` / `patch` 配置把它组合进运行时，而不是去改代码：

```bash
harness list                               # 列出配置解析出的插件
harness run -p examples/hello-plugin.patch.yml "调用 hello 工具打个招呼"
harness validate my-plugin/                # 校验插件定义
```

如果你要把它分发出去给别人安装，先给目录签名：

```bash
harness plugin-keygen --out ./plugin-signing-key.pem   # 私钥，权限 0600；同时打印公钥
harness plugin-sign ./my-plugin --key ./plugin-signing-key.pem
harness plugin-verify ./my-plugin                      # 信任清单取自 HARNESS_PLUGIN_KEYRING / plugins.trustedKeys
```

---

## 一个完整的端到端示例

下面这条链路展示了筑星 Harness 的「**学 → 做 → 记 → 长**」闭环：

**① 下达任务**
> 「把项目 0.4.0 的用户手册生成出来，并核对版本一致性。」

**② 自主执行**
- 读取项目文件与历史会话；
- 定位生成脚本 `scripts/gen-user-manual.cjs`；
- 经沙箱裁决执行脚本，生成 `.docx` 与 `.pdf`；
- 自动校验版本号、标题、页数、路径一致性。

**③ 交付产物**
```
dist/筑星Harness-用户手册-0.4.0.docx
dist/筑星Harness-用户手册-0.4.0.pdf
```

**④ 沉淀知识**
- 将本次规范、流程、校验点写入知识库，带溯源；
- 后续问答可回溯到本次产物与相关条款。

**⑤ 沉淀技能**
- 将「版本发布 → 手册生成 → 一致性校验」流程固化为 Skill；
- 下次发版时**直接复用，无需重新推理**。

> 这就是「**随用户成长**」的最小单元：用一次，学一次，沉淀一次，下一次更强。

---

## 与同类项目的差异

| 维度 | 传统 Agent 框架 | Claude Code 类工具 | **筑星 Harness** |
|------|------------------|--------------------|-------------------|
| 内核职责 | 常内置业务逻辑 | 绑定单一厂商 | **内核无特权，能力全为插件** |
| 工具生态 | 封闭，接集成要写定制代码 | 封闭 | **内置 MCP 客户端——任意 stdio MCP 服务器都能接** |
| 插件信任 | 几乎没有 | 有限 | **权限清单 + ed25519 签名（配置信任清单后 fail-closed）** |
| 模型绑定 | 常绑定单一厂商 | 绑定单一生态 | **完全可插拔，兼容 OpenAI 协议** |
| 国内生态适配 | 弱 | 弱 | **百炼 / 千问 / DeepSeek 可接入，内网可跑** |
| 本机文件交付 | 多为文本建议 | 有限 | **脚本执行 + 产物生成 + 一致性校验** |
| 技能来源 | 人工编写 | 人工编写 | **跑通即沉淀、自主复用** |
| 知识系统 | 一般仅 RAG | 会话上下文 | **RAG + 溯源 + 多空间管理** |
| 权限体系 | 粗粒度 | 中粒度 | **`read-only` / `workspace-write` / `danger-full-access`** |
| 可观测性 | 零散日志 | 厂商私有 | **可选 OTLP/JSON + GenAI 语义约定，另加内核事件** |
| 演进方向 | 功能迭代 | 提示词优化 | **向自进化内核演进** |

---

## 应用场景（多行业）

「筑星计划」的本质，是 **AI 能力与多行业的深度结合**。典型方向包括：

- **政务 / 工程**：规范检索、条款溯源、文档生成、合规性校验；
- **法律**：卷宗结构化、案例库、文书起草与引用校验；
- **医疗**：指南知识库、诊疗路径沉淀、报告生成；
- **制造 / 工业**：工艺知识沉淀、设备操作文档、质检流程；
- **企业办公**：本地文档批处理、报表生成、跨文档自动化；
- **科研 / 教育**：文献知识库、综述写作、实验流程沉淀。

> 核心共性：**强规范、强交付、强合规、强知识沉淀**——正是这些场景，需要「可追溯、可治理、可成长」的 Agent 运行时。

---

## 命令总览

| 命令 | 说明 |
| --- | --- |
| `harness run` | 运行 Agent 任务（进度输出 / `--json` / `--stream` / `--timing`） |
| `harness dev` | 开发模式：监听插件变化自动热重载并重跑 |
| `harness login` | 交互式持久化凭证 |
| `harness config get/set/rm/list` | 读写持久化配置 |
| `harness session ls/show/rm/archive/unarchive` | 会话管理（JSONL 持久化） |
| `harness space ls/add/rename/rm` | 工作区（项目）管理 |
| `harness models list/stats` | 多子模型管理（列表 / 实时性能指标） |
| `harness memory list/add/rm/clear` | 跨会话记忆管理 |
| `harness skill list/add/rm/show/run/create` | 技能管理 / 调用 |
| `harness tools list/test` | 列出已注册工具 / 试跑一个工具 |
| `harness list` | 列出配置解析出的插件 |
| `harness validate` | 校验插件定义 |
| `harness create-plugin` / `install` | 插件脚手架 / 本地安装 |
| `harness plugin-keygen` | 生成 ed25519 签名密钥对 |
| `harness plugin-sign` | 对插件目录签名 |
| `harness plugin-verify` | 按信任清单校验插件目录签名 |
| `harness introspect` | 本体自省（列出插件、权限与工具） |
| `harness doctor` | 环境自检（版本 / 配置 / 目录可写 / 可选端点连通性） |
| `harness web` | 启动 Web UI |
| `harness update` | 应用内更新 |
| `harness completion` | 生成 shell 补全 |
| `harness version` | 版本号 |

---

## 文档

- [docs/quickstart.md](docs/quickstart.md) — 快速开始（5 分钟跑通）
- [docs/cli.md](docs/cli.md) — CLI 命令参考
- [docs/configuration.md](docs/configuration.md) — 配置（凭证 / patch / profile / 沙箱 / MCP 服务器）
- [docs/plugins.md](docs/plugins.md) — 插件开发、权限清单与签名
- [docs/multi-model.md](docs/multi-model.md) — 多子模型路由与编排
- [docs/security.md](docs/security.md) — 安全模型
- [PLAN.zh-CN.md](PLAN.zh-CN.md) — 设计、里程碑、商用化路线图
- [REPORT.zh-CN.md](REPORT.zh-CN.md) — 优化内容与测试结果

---

## 许可

双许可（源码可用 · 非商业免费 · 商业付费授权）

[查看 LICENSE](LICENSE)

如需商业授权、私有部署或定制开发，请联系我们（见 LICENSE）。

---

*「它不只是跑任务——它是在学习，如何更好地跑任务。」*
