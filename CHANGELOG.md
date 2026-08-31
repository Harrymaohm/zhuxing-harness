# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
