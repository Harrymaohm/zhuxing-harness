# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-20

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
