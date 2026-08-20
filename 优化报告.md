# 筑星 Harness 全面优化报告

> 日期：2026-08-20
> 范围：代码性能、资源利用率、用户体验、系统稳定性
> 结论：**全部优化措施已实施并通过测试验证，性能与体验均达预期。**

---

## 1. 优化目标

| 维度 | 目标 |
| --- | --- |
| 代码性能 | 插件加载启动提速；避免重复转译与 import 缓存失效 |
| 资源利用率 | 会话内存可约束；转译产物可复用；并发加载不重复构建 |
| 用户体验 | 秒级命令入口；一次登录免重复传 Key；运行有实时进度；输出结构化可解析；错误可自助解决 |
| 系统稳定性 | 统一错误分类；运行失败保证资源清理；默认安全级别；凭证输出脱敏 |

---

## 2. 优化内容与实施过程

### 2.1 代码性能

**P-1 插件转译内容哈希缓存**（[loader.ts](file:///e:/筑星Harness/packages/config/src/loader.ts)）
- 现状问题：每次 `run/validate` 都重新执行 esbuild 转译，且 `?t=时间戳` 强制 import 缓存失效。
- 实施：产物文件名改为「源文件名-内容SHA256(12位).mjs」，内容未变则跳过构建直接 import（稳定 URL 复用模块缓存）；增加单进程并发互斥锁（`withBuildLock`），并发加载同一插件不重复构建。
- 预期效果：热启动跳过 esbuild；多插件/大插件场景收益显著。

**P-2 CLI 阶段计时**（[cli.ts](file:///e:/筑星Harness/packages/cli/src/cli.ts)）
- 新增 `--timing`：输出配置解析 / 挂载 / 插件加载 / Agent 运行 / 总计五段耗时，为性能观测提供工具。

### 2.2 资源利用率

**R-1 会话事件上限修剪**（[session](file:///e:/筑星Harness/packages/session/src/index.ts)）
- `MemorySessionStore` 新增 `maxEventsPerSession` 选项，超出修剪最旧事件；默认不限制（保持 append-only 铁律），由使用者按场景开启。
- 避免超长会话内存无限增长。

**R-2 转译产物复用**
- 内容哈希缓存同时减少磁盘重复产物与 CPU 转译开销（见 P-1）。

### 2.3 用户体验

**U-1 全局命令入口**（[package.json](file:///e:/筑星Harness/package.json)）
- 根工程新增 `bin: { harness: "packages/cli/dist/cli.js" }`（`npm link` 后全局可用）与 `pnpm harness` 快捷脚本；不再需要 `node packages/cli/dist/cli.js`。

**U-2 登录与配置持久化**（[config-store.ts](file:///e:/筑星Harness/packages/cli/src/config-store.ts)）
- 新增 `harness login`：交互式收集 API Key / Base URL / 模型 / 工作区 / 沙箱级别，写入 `~/.zhuxing-harness/config.json`（权限 600）。
- 新增 `harness config get|set|list|rm`；支持 `HARNESS_CONFIG` 环境变量覆盖路径（测试/多环境）。
- `run` 自动读取配置与工作区 `.env`（不覆盖已有环境变量），免去每次传参。

**U-3 实时进度输出**（[output.ts](file:///e:/筑星Harness/packages/cli/src/output.ts)）
- `run` 期间订阅 `agent/*`、`tools/*` 事件，实时显示「调用模型 / 工具调用 / 工具结果 / 步骤完成」，消除长时间静默；非 TTY 自动禁用颜色，管道输出纯净。

**U-4 结构化输出**
- `--json`：输出 `{ ok, content, steps, finishedReason, sessionId, timing }`，供脚本消费。
- 默认输出分节（结果 / 步骤摘要），完整轨迹改为 `--verbose` 才打印（减少噪音）。

**U-5 脚手架增强**（`create-plugin`）
- 模板默认演示三种能力：工具注册（带 schema/required）、事件订阅、可逆副作用，并注入依赖声明。

**U-6 校验建议**（`validate`）
- 校验通过后给出开发期建议（缺 description、插件既无依赖也无服务等）。

### 2.4 系统稳定性

**S-1 结构化错误分类**（[errors.ts](file:///e:/筑星Harness/packages/kernel/src/errors.ts)）
- 新增 `HarnessError { code, hint }`，分类：`AUTH / NETWORK / CONFIG / PERMISSION / PLUGIN / TIMEOUT / UNKNOWN`；`HarnessError.from()` 对既有错误启发式归类。
- sandbox 权限拒绝改抛 `PERMISSION` 错误并附修复提示；CLI 统一 catch 输出「错误 + 提示」。

**S-2 运行错误边界**
- `cmdRun` 主体置于 `try/finally`，任何路径（含插件挂载失败、Agent 异常）都保证 `app.dispose()` 清理资源。

**S-3 默认安全级别**
- `run` 沙箱默认级别由 `workspace-write` 改为 `read-only`（写操作需显式提权）。

**S-4 凭证输出脱敏**
- `maskSecrets()`：对 `sk-` 前缀令牌与 `KEY=VALUE` 形式打码；CLI 全部输出（进度、结果、轨迹、错误）统一经过脱敏。

---

## 3. 测试结果

**全量回归：63 项测试全部通过**（`pnpm -r test` + `pnpm test:e2e`），typecheck 通过。

新增测试（14 项）：

| 测试文件 | 覆盖点 |
| --- | --- |
| [errors.test.ts](file:///e:/筑星Harness/packages/kernel/__tests__/errors.test.ts)（7） | 错误分类 AUTH/NETWORK/TIMEOUT/PERMISSION/PLUGIN/UNKNOWN；脱敏 sk- 与 KEY=VALUE、短令牌不误伤、空输入安全 |
| [cache.test.ts](file:///e:/筑星Harness/packages/config/__tests__/cache.test.ts)（2） | 内容哈希缓存：相同内容复用产物、修改生成新产物；并发加载不重复构建 |
| [prune.test.ts](file:///e:/筑星Harness/packages/session/__tests__/prune.test.ts)（2） | 事件上限修剪最旧事件；默认不限制 |
| [config-store.test.ts](file:///e:/筑星Harness/packages/cli/__tests__/config-store.test.ts)（3） | 配置 save/load 往返；.env 加载且不覆盖已有变量；缺失配置返回空对象 |

既有 49 项测试（内核/热插拔压力/工具/会话/Agent/LLM/沙箱/配置/CLI/SDK/端到端）全部保持通过，无回归。

---

## 4. 性能对比（实测）

基准脚本：[bench.mjs](file:///e:/筑星Harness/scripts/bench.mjs)（`node scripts/bench.mjs`，本机 Node 22 / Windows）

### 4.1 插件转译启动（loadPluginModule）

| 指标 | 优化前 | 优化后（缓存命中） | 加速比 |
| --- | --- | --- | --- |
| 最小耗时 | —（每次均转译） | 0.7 ms | — |
| 平均耗时 | 22.5 ms（冷） | 0.8 ms（热） | **≈ 28x** |

（冷启动含 esbuild 转译；热启动内容未变跳过构建，含 import 执行。）

### 4.2 CLI 进程级（validate 链路，含 Node 启动开销）

| 场景 | 耗时 |
| --- | --- |
| 首次运行（冷，含转译） | 199.1 ms |
| 再次运行（热，缓存命中） | 190.3 ms |
| 转译环节节省 | 8.8 ms（Node 启动与模块加载为进程主导成本） |

> 说明：单插件场景下转译占比小；多插件 / 大插件 / `dev` 热重载场景下缓存收益线性放大（bench 中单插件转译即约 22ms/个）。

### 4.3 真实模型运行（DeepSeek v4-flash，`--json --timing`）

```
total: 2546ms = configParse 25ms + mount 3ms + pluginLoad 83ms + agentRun 2435ms
```

插件加载（含转译缓存命中 import）仅占 83ms；Agent 模型交互为主导，符合预期。

---

## 5. 使用效果验证（真实命令冒烟）

| 场景 | 结果 |
| --- | --- |
| `harness config set/list/get/rm` | ✓ 正常，apiKey 输出脱敏为 `sk-***890` |
| 无 Key 运行 | ✓ 输出「✗ 缺少 API Key + 提示：运行 harness login」 |
| `harness run --json --timing` | ✓ 结构化 JSON + 五段耗时 |
| `harness run`（普通模式） | ✓ 实时进度：`▶ 第 1 步 → ↳ 工具 hello(...) → ✓ hello → ✓ 步骤完成` |

---

## 6. 影响文件清单

| 模块 | 文件 | 变更 |
| --- | --- | --- |
| kernel | `errors.ts`（新增）、`index.ts` | 结构化错误、脱敏 |
| config | `loader.ts` | 内容哈希转译缓存 + 并发锁 |
| sandbox | `index.ts`、`package.json` | 权限错误结构化（PERMISSION） |
| session | `index.ts` | 事件上限修剪选项 |
| cli | `cli.ts`（重写）、`config-store.ts`（新增）、`output.ts`（新增）、`base-bundle.ts` | 全局命令、login/config、进度、--json/--timing/--verbose、错误提示、默认安全级别、脚手架增强 |
| 根工程 | `package.json` | `bin`、`pnpm harness` 脚本 |
| scripts | `bench.mjs`（新增） | 性能基准 |

## 7. 遗留项完成情况（本轮新增）

此前遗留的 4 项已全部落地并验证：

| 遗留项 | 状态 | 实现与验证 |
| --- | --- | --- |
| **token 级流式输出** | ✅ | llm `ChatProvider.stream()`（SSE 解析，支持 `data: [DONE]`、tool_calls 增量累积、usage）；agent `onToken` 透传（不支持流式时自动回退 chat）；CLI `--stream` 逐 token 渲染。真实模型验证通过（逐字滚动输出） |
| **`harness dev` 热重载** | ✅ | 监听 patch 插件入口文件内容哈希（500ms 轮询），变化时卸载→重挂→自动重跑任务；Ctrl-C 退出。真实演示：修改插件后 v2 工具文案自动生效 |
| **会话持久化管理** | ✅ | `FileSessionStore`（JSONL 追加，跨进程）；`harness session ls/show/rm`（支持 id 前缀匹配）；`run` 默认写入 `~/.zhuxing-harness/sessions`（`--session-dir` / `HARNESS_SESSION_DIR` 可覆盖） |
| **shell 补全** | ✅ | `harness completion [bash|zsh]` 生成子命令补全脚本 |

**过程中修复的设计缺陷**：工具注册不感知插件生命周期 → `ToolRegistry.register` 返回注销函数，插件用 `ctx.effect` 绑定（示例与脚手架模板已更新），热重载/卸载零残留。这正是计划书 8.1「热插拔专项」中"副作用清理"的落地补全。

**测试增量**：llm SSE 流式（2）、agent onToken（2）、FileSessionStore（4）、tools disposer（1）——共新增 9 项，**总计 72 项测试全部通过**。

## 8. 遗留与后续

- `run --resume`（会话续跑，基于 FileSessionStore 与 AgentLoop 会话恢复接口）。
- 网页 UI（二期规划，作为插件接入）。

## 9. 代码整洁与架构审查（2026-08-20 交付前检查）

### 9.1 代码整洁 ✅

| 检查项 | 结果 |
| --- | --- |
| 未使用依赖 | 移除 `llm`、`session` 两个包中未使用的 `@zhuxing/harness-kernel` 依赖（全量扫描 src import 与 package.json 一一核对） |
| 运行时产物 | 删除 `plugins/`（install 安装副本）与 `.harness-cache/` 转译缓存，均已加入 `.gitignore`（含 `dist/`、`node_modules/`） |
| 冗余副本 | `plugins/hello-plugin.patch.yml` 与 `examples/hello-plugin.patch.yml` 重复 → 保留 examples 一份，更新文档引用 |
| 类型整洁 | `strict` + `noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch` 全程开启，typecheck 零告警 |
| 测试污染 | CLI 测试使用 `HARNESS_CONFIG` / `HARNESS_SESSION_DIR` 指向临时目录，不触碰用户配置 |

### 9.2 架构清晰 ✅

| 检查项 | 结果 |
| --- | --- |
| 分层 | `kernel`（无业务逻辑的内核）→ `config/session/agent/tools/sandbox/llm`（能力插件）→ `sdk`（聚合导出）→ `cli`（组合入口），依赖单向无环 |
| 包职责 | 每个包单一职责，`src/index.ts` barrel 导出完整且命名一致 |
| 无特权核心 | base bundle 全部能力均为插件（sandbox/session/tools/llm/core-tools/agent），可整体替换 |
| 生命周期 | 工具注册返回 disposer 并绑定 `ctx.effect`，热重载/卸载零残留 |
| 已知取舍 | `cli.ts` 单文件 ~780 行为按命令函数组织（main 分发 + 每命令一函数），包级架构已清晰，暂不拆分以避免回归 |

### 9.3 测试 ✅（最终状态）

- **79 项测试全部通过**（`pnpm -r test` + `pnpm test:e2e`），`pnpm typecheck` 通过，`pnpm -r build` 通过。
- 本轮新增 7 项 CLI 进程级冒烟测试（help / validate / list / completion / config 脱敏 / session / 错误分类）。
- 覆盖范围：内核（含热插拔压力测试）、配置分层与转译缓存、会话（内存/文件/修剪）、模型（非流式/SSE 流式）、工具管道、沙箱策略、Agent 循环（含流式透传）、SDK DSL、CLI 全命令、端到端真实链路。
