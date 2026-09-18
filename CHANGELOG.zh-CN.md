# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-09-18

### MCP 客户端

- 支持以 stdio 传输接入 MCP 服务器，可直接使用 MCP 生态工具
- 双协议版本协商：先用 `server/discover` 探测现代协议（`2026-07-28` 起为无状态协议，**没有** `initialize` 握手），未被识别时回落至 `initialize` 握手

### 技能兼容 Agent Skills 的 `SKILL.md`

- 新增 `parseSkillMarkdown`，可解析 `<技能名>/SKILL.md`（读取 YAML frontmatter 的 `name` / `description`）；技能定义新增 `source` 字段标识来源格式
- 技能上传链路支持 `.md` 文件与 zip 内的 `SKILL.md`；落盘为真正的 `<技能名>/SKILL.md`，不改写为原 yaml 技能格式
- 占位符校验对 `SKILL.md` 来源跳过（该规范没有 inputs 概念）

### 插件权限清单与签名校验

- 插件清单可声明所需权限，工具执行时在边界处强制校验
- 新增 ed25519 插件签名校验（fail-closed）：对插件目录内容计算摘要，排除 `.map` 与 `*.tsbuildinfo`，避免重新构建被误判为篡改

### 可观测性（OTel GenAI 遥测，默认关闭）

- 新增 `telemetry` 插件，以零依赖方式导出 OTLP/JSON（`traceId` / `spanId` 为十六进制，`intValue` 为字符串）
- 内核补齐 LLM 调用事件 `agent/llm-request` / `agent/llm-response` / `agent/llm-error`，使 chat span 能被真正生成

### 安全修复

- **工具结果凭据改为无条件脱敏**：原实现仅在工具名或参数命中关键词时才脱敏，而 MCP 工具返回的裸令牌会明文写入会话日志；现脱敏无条件执行，凭据抽取仍按线索触发，并保持 `text` / `json` 字段形状不变
- `EventBus.emit` 隔离监听器异常：单个监听器抛错不再穿透为 `AgentLoop.run()` 的 rejection 而中断整轮对话

### 工程

- 接入 ESLint 与 secretlint 秘密扫描，新增第三方依赖与许可证声明目录 `licenses/`

## [0.3.9] - 2026-09-08

### Agent 目标校验（`verifyGoal`）

- 模型给出最终答复且本回合调用过工具时，先用一次轻量模型自检「目标是否真正达成」；未达成则把缺漏反馈给模型继续补做（默认最多 2 次），避免「看似完成、实则遗漏」
- 新增 `AgentOptions.verifyGoal` / `GoalVerifyContext` / `GoalVerifyResult`、`maxGoalVerify`（补做上限）；内置 `defaultVerifyGoal` 用一次轻量自检兜底，无法判定时放行
- 未通过校验时新增 `agent/post-step` 事件（`done:false, verifyFailed:true`），校验意见写入会话（`system:agent` 的 `goalVerify` 记录）
- 循环内上下文管理：长会话（多轮工具调用，尤其校验会鼓励继续调工具）每轮调用模型前若超预算则重新滑动窗口裁剪，防止上下文溢出

### 交付简报与参考对话注入（`delivery-brief`）

- 每次 Agent 最终答复（`finishedReason=stop`）后自动沉淀一份「过程+背景」简报写入会话私有记忆，标签 `delivery-brief`（`buildDeliveryBrief`）
- 参考对话注入优先注入交付简报；无简报时才回退到完整记录（超过 16KB 自动截断并标注），防止撑爆 systemPrompt
- `buildSessionMemoryPrompt` 新增 `excludeTags` 选项；注入参考对话其它私有记忆时排除交付简报，避免与简报重复

### 流式思考输出（`reasoning_content`）

- `AgentOptions` 新增 `onReasoning` 回调；`AgentLoop` 流式输出推理模型思考内容（`chunk.reasoning`）
- assistant 事件记录 `thinking`，历史重建（`rebuildMessages`）可还原思考内容

### 知识库文档字段运行时更新

- `FileKnowledgeStore.updateDocument(id, patch)`：支持改 title/source/tags/workspace/specId/scope，以及空间/目录（spaceId/folderId）归属；运行时直接改内存 cache 并 flush，无需重启生效
- 新增 `PATCH /api/knowledge/docs/:id`；Web UI `updateKnowledgeDoc()` 助手
- 校验目标空间/目录存在；标题空串忽略、tags 空数组清空；`updatedAt` 更新

### Web 更新状态与内核热更新

- 新增 `GET /api/update/status`：读取更新进程写入的 `success / rolled-back / failed` 状态（含《本次内核变更说明》）
- `handleChat` 每次指令前 `runtime.maybeReload()`，内核文件/版本变化则无重启换上新内核代码；`res.close` 时停止 SSE 推送

### Web UI 回合重建（Trae 风格）

- 历史对话按「回合」重建：一次用户输入 → 多步模型调用/工具 → 结论合并为一条助手消息，含思考、调用过程与最终结论，观感与实时 SSE 一致
- 纯文本回复（无工具调用）仅保留文字，不产生执行过程骨架

### 系统提示词增强

- 默认 system prompt 新增「任务处理规则 + 记忆沉淀规则」：先看记忆判断复用已有流程、可复用则只做差异调整、新流程先想清楚再动手；任何可复用流程/用户画像信息都应沉淀，多沉淀多记忆、和用户一起成长

### 工程与发布

- 新增 `@zhuxing/harness-runtime` 包（0.3.9）：构建可热更新的 `RuntimeResources`（app/agent/tools/memory/skills…），供 Web 外壳动态加载；含 `kernelSelfTest` 自检与 `configFingerprint`
- 修复内部 workspace 依赖版本范围，统一为 `workspace:^`，确保构建拓扑正确（e516d7b）
- 修复 CI 中 pnpm 版本冲突，移除 workflow 重复 version 配置，改用 `packageManager` 统一版本（2e24f53）
- 仓库文档中英分离，新增 `.zh-CN.md` 补页（README/CLI/configuration/multi-model/plugins/quickstart/security）；PLAN/REPORT 中文版；移除 README 中 `&&` 链接命令以兼容 Windows
- 精简仓库：移除 web 编译产物与用户手册二进制（docx/pdf）并加入 gitignore；移除废弃脚本（build-icon.ps1 / gen-harness-doc.ps1 / gen-poster.ps1 / test-dashscope.ps1）
- CLI `cmdUpdate` 的 `applyLocalZip` 修正为 await

## [0.3.8] - 2026-08-31

### Web 设置面板：主模型 / 子模型 / 生图模型 / 运行环境

- 设置模态升级为分区式（Tab）：主模型（Key/端点/模型名）、子模型（卡片式增删：ID/模型名/显示名/上下文窗口/能力标签点选/独立端点与 Key）、生图模型（模型/端点/Key/尺寸）、运行环境（工作区/沙箱级别下拉）
- 新增 `harness-image-tools` 插件：配置 `imageModel` 后注册 `generate_image` 工具（OpenAI 兼容 `/images/generations`，支持 url 与 base64 响应）；CLI run/dev 与 Web 均透传 `imageModel` 配置
- 密钥安全：`GET /api/config` 对主/子模型/生图 apiKey 全部脱敏；保存时未修改的密钥不回传，服务端按模型 id 合并保留旧值（新增回归测试）

### 多子模型路由与编排（`@zhuxing/harness-model-router`）

- 新包 `packages/model-router`：模型注册表（热插拔，register 返回 disposer）、实时性能监控（滑动窗口：成功率/延迟/token/成本）、选择算法（任务意图 + 上下文适配 + 性能评分，权重可配）、统一交互入口（`ModelRouter` 实现 `ChatProvider`，失败自动降级）、模型间通信协议（`ModelOrchestrator.delegate/listModels`）
- bundle 新增 `harness-model-router` 插件：`config.models` 多模型注册，注册 `pick_model` / `list_models` 工具供主编排模型动态委派子任务；提供服务 `modelRegistry/modelMonitor/modelSelector/modelRouter/orchestrator`；插件卸载自动注销全部子模型
- CLI：新增 `harness models list/stats`；`run`/`dev` 支持 `--models <json>` 与 `--model-id <id>`（显式指定子模型，经路由器保留监控与降级）
- Web：`config.models` 透传；新增 `GET /api/models`
- 文档：`docs/multi-model.md`；发布拓扑顺序加入 model-router（13 包）

### Windows 安装包（NSIS，二次分发）

- `scripts/build-nsis.mjs` + `scripts/nsis/installer.nsi`：生成 `zhuxing-harness-setup-<版本>.exe`
- 内置便携 Node 22 + 单文件 CLI + Web UI 静态资源 + esbuild 运行时，免管理员安装（`%LOCALAPPDATA%`）、自动写入用户 PATH、开始菜单快捷方式、卸载器
- `scripts/build-dist.mjs`：组装安装内容目录（规避 Node `cpSync` 在中文路径下的原生崩溃，改用自定义递归复制）
- 安装/卸载/运行全链路静默冒烟验证通过（version / doctor / validate / web / 卸载）

### 迭代数据保留与最终折叠

- 迭代过程中全部中间数据（临时数据、过程变量、中间计算结果、步骤信息）完整保留在会话日志，并持续参与后续迭代（`AgentLoop` 步骤间消息全量累积 + 工具参数/结果完整落日志）
- **仅在生成最终输出时折叠**：新增 `foldResult()`（agent 包）生成交付摘要；CLI `--summary` 输出折叠摘要，完整数据仍可通过 `harness session show <id>` 查看；Web UI 长结果默认折叠、点击展开
- 数据完整性测试：验证中间参数/结果完整保留、中间结果参与后续迭代、折叠不删除任何数据

### 安全策略优化

- 沙箱 read-only 改为「只拦截明确的写意图，放行只读查询」：修复 `sed` / `awk` 查询被误拦截的问题（`sed -n`/`awk '{print}'` 等查询命令现可正常执行；`sed -i` 原地写仍拦截）
- 明确查询放行清单：`git status/log/diff`、`grep/find/cat/head/tail`、`npm view`、`pip list`、`curl`（无 `-o`）、`echo $VAR` 等
- 文档（`docs/security.md`）同步细化级别行为说明

### 新增

- **Web UI（对话 / 工作 / 交付）**：`harness web` 启动（默认 3080）；HTTP + SSE 流式 API（health/sessions/config/chat）；React 前端（流式 token、工具进度卡片、会话侧栏、交付区、设置）
- **`@zhuxing/harness-bundle`** 独立包：基础插件组合层（cli 与 web 共用，消除循环依赖）
- CLI `web` 命令；发布顺序更新为 12 包拓扑

## [0.1.0] - 2026-08-20

### 工程与发布（商用化）

- 发布工具链：`scripts/publish.mjs`（拓扑顺序发布 + publishConfig public + 发布前 `pnpm check` 门禁）、`scripts/bump.mjs`（统一版本）、`scripts/bundle-cli.mjs`（单文件二进制）
- 聚合安装包 `@zhuxing/harness`：`npm i -g` 一条命令获得全局 `harness`
- 质量门禁 `pnpm check`、CI（GitHub Actions，ubuntu+windows × node20/22）、git 版本控制、README / LICENSE(MIT) / CHANGELOG
- 用户文档：`docs/`（quickstart / cli / configuration / plugins / security）
- 退出码规范（0/1/2）、`harness version` / `harness doctor` 环境自检

### 新增（首个可运行版本，M0–M5 里程碑）

- **内核（kernel）**：Context / 生命周期 / 依赖注入 / 事件总线 / Service 注册；热插拔（挂载/卸载/重载、级联清理、循环依赖检测、in-flight 追踪、pending 等待超时）
- **配置（config）**：profile/bundle/patch 分层合并；TS 插件 esbuild 转译 + 内容哈希缓存（≈28x 热启动加速）
- **会话（session）**：追加式事件日志、fork / replay；内存与 JSONL 文件两种存储；事件上限修剪选项
- **Agent（agent）**：turn/step 循环、`agent/*` 与 `tools/*` 拦截事件、流式透传（onToken）
- **工具（tools）**：注册表 + 执行管道（前置拦截 → 沙箱守卫 → 超时重试 → 结果规范化）；注册返回 disposer 支持生命周期绑定
- **沙箱（sandbox）**：read-only / workspace-write / danger-full-access 三级策略，结构化权限错误
- **模型（llm）**：统一 ChatProvider 接口；OpenAI 兼容端点；SSE 流式（tool_calls 增量累积、usage）
- **SDK（sdk）**：聚合导出 + `defineTool` DSL + `createOpenAIProvider`
- **CLI（cli）**：`run / dev / login / config / session / validate / create-plugin / install / list / doctor / completion / version`
  - 实时进度输出、`--stream` 逐 token、`--json`、`--timing`、`--verbose`
  - 凭证持久化（`~/.zhuxing-harness/config.json`，600）+ `.env` 加载 + 输出脱敏
  - 结构化错误分类（AUTH/NETWORK/CONFIG/PERMISSION/PLUGIN/TIMEOUT/UNKNOWN）与修复提示
  - 退出码规范：0 成功 / 1 运行时错误 / 2 用法错误
  - 默认沙箱级别 read-only（安全默认）
- **工程**：pnpm workspace、TypeScript strict、质量门禁（`pnpm check`）、性能基准（`node scripts/bench.mjs`）、示例插件

### 质量

- 79 项测试（单元 + 热插拔压力 + 端到端），`pnpm check` 一键全量通过
- 真实模型闭环验证（DeepSeek v4-flash）：插件工具 + 内建工具编排、会话回放、流式输出、dev 热重载
