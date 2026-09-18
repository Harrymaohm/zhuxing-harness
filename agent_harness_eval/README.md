# Agent Harness 评测（agent_harness_eval）

本目录是《Agent Harness 测试计划案》的落地实现。它回答的问题不是「代码能不能编译」，
而是：

> **一次 prompt 调整、一次工具 Schema 变更或一次模型升级，有没有让 Agent 整体变差？**

## 核心原则

| 原则 | 落地方式 |
| --- | --- |
| 绝不采信模型自述 | 任务成败只由 `verifiers.mjs` 的 F2P/P2P 测试结果裁定；模型说「完成」只用于检测虚假交付，绝不作为完成依据 |
| 未知不得伪装成合格 | 维度无法判定时 `score: null` 且 `counted=false`，评分卡同时暴露 `coverage`；缺费率时金额是 `null` 而不是 `0` |
| 成本必须在网络层采集 | Harness 自报的 token 会隐藏子查询与后台索引，真实 usage 由 `telemetry-proxy.mjs` 在 HTTP 层拦截 |
| 固定底层 LLM | 任务语料内嵌 `mock` 剧本驱动确定性模型应答，评测不赌模型当天的发挥 |
| 隔离且可复算 | 每个任务一份隔离工作区（`git worktree` 或 fixture 副本）；重复运行必须 `reset` 账本 |
| 证据分级 E0–E3 | 单轮运行一律封顶 E1；`repeats >= 2` 且各轮结论一致才重算为 E3 |

## 目录

```
run.mjs                  层 1 入口：八边界确定性评测（真实 harness 组件 + mock 外部系统）
run-tasks.mjs            层 2 入口：任务层评测（真实 CLI + 隔离工作区 + 网络层遥测）
src/
  task-schema.mjs        任务语料 Schema 与加载器
  workspace.mjs          隔离工作区（worktree / fixture）、改动清单、仓库指纹
  cli-adapter.mjs        被测 CLI 定位、干净环境、隔离配置、结果契约解析
  telemetry-proxy.mjs    网络层遥测代理（mock/record 双模式 + 故障注入）
  trajectory.mjs         会话轨迹解析与过程画像
  verifiers.mjs          F2P/P2P 程序化验证器（唯一成败裁定者）
  evaluators.mjs         五维评估器 + 评分卡
  task-runner.mjs        单任务 / 重复运行编排
  task-report.mjs        套件报告与套件门禁
tasks/                   任务语料（Golden Dataset）
  pricing.json           费率表（加载器会显式跳过，不会被当成任务）
  fixtures/<name>/       自包含素材目录
__tests__/               评测工具自身的单测（判定口径的回归保护）
```

## 怎么跑

```bash
pnpm test:eval        # 层 0：评测工具自身单测（秒级，已并入 pnpm check）
pnpm eval:boundaries  # 层 1：八边界确定性层（ASR=0 / 八边界全 Proven）
pnpm eval:tasks       # 层 2：任务层（F2P/P2P + 三维评估 + 评分卡 + 套件门禁）
```

常用参数（`node agent_harness_eval/run-tasks.mjs --help`）：

```bash
node agent_harness_eval/run-tasks.mjs --list                       # 只看选中哪些任务
node agent_harness_eval/run-tasks.mjs --ids smoke-bugfix-off-by-one --keep-workspace
node agent_harness_eval/run-tasks.mjs --types security_boundary --format markdown
node agent_harness_eval/run-tasks.mjs --model deepseek-v4-flash --prefer installed
```

退出码：`0` 门禁通过｜`1` 门禁未通过｜`2` 用法或环境错误。

## 任务语料

任务以 JSON 版本化，字段同时接受 snake_case 别名（`task_type` / `max_steps` /
`allowed_paths` / `fail_to_pass` …），加载期一次性校验完毕——「跑完半小时才发现
任务定义写错」是不允许的。当前覆盖 6 类：

| taskType | 说明 | 语料 |
| --- | --- | --- |
| `bug_fix` | 修缺陷 | `smoke-bugfix-off-by-one` |
| `feature` | 加功能 | `feat-slugify-options` |
| `refactor` | 重构（对外行为不变） | `refactor-extract-parse` |
| `test_authoring` | 补测试 | `test-authoring-account` |
| `failure_recovery` | 上游故障下仍要交付 | `fr-recover-http500` |
| `security_boundary` | 安全边界（拒绝越界） | `sec-boundary-path-guard` |

### 编写规范（都是踩过的坑）

1. **F2P/P2P 的期望名必须是测试源码里 `test('名字')` 的第一个参数**。
   文件级子测试（如 `not ok 1 - x.test.mjs`）会被匹配池剔除，不能拿来冒充用例。
2. **F2P 在改动前必须失败**。改动前就绿的用例会被判 `nonDiscriminating`（无区分度），
   属于语料缺陷而不是 Harness 缺陷。
3. **`repository.mode = "fixture"`**：素材目录自包含、零外部依赖，路径相对任务文件解析。
4. **`allowedPaths` 是硬边界**：`outcome=pass` 却没有改动会命中 `change-present`（P0）。
5. **`security_boundary` 豁免写证据**：该类型允许全程不写文件（正确行为可能就是拒绝）。

### mock 剧本（`mock` 字段）

```jsonc
{
  "rules": [{ "when": { "hasTools": false }, "reply": { "content": "OK" } }], // 优先于 plan
  "plan": [ { "content": "…", "toolCalls": [{ "name": "write_file", "arguments": { "path": "a.mjs", "content": "…" } }] } ],
  "fallback": { "content": "任务已完成。" },
  "faults": [{ "at": 4, "kind": "http500" }]
}
```

- `rules` 的条件支持 `contains` / `regex` / `hasTools` / `minCall` / `maxCall`。
- `plan` 按游标顺序消费；耗尽后回落到 `fallback`。
- **模型无 toolCalls 时 Harness 会额外发起一次「目标校验」调用**（不带 `tools`）。
  `hasTools === false` 的规则就是为它准备的；缺了它，`plan` 耗尽后目标校验反复失败，
  运行会以 `finishedReason: "unverified"` 收尾。
- **`workspace-write` 档位下 `checkCommand` 拒绝一切「写意图」命令**（`rm`/`>`/`sed -i`…），
  所以剧本里的写操作一律走 `write_file`，不要用 `shell`。
- **`faults[].at` 是当前账本里 1-based 的绝对 `callIndex`**，精确相等才命中；
  `fired` 计数在 `reset()` 之外保留，因此每轮都必须 `setFaults()` 重新武装。
  把故障打在目标校验那次调用上，就能真实演练「上游 5xx → 校验失败 → 重试后交付」的恢复路径。

### 费率表（`tasks/pricing.json`）

```json
{ "currency": "CNY", "unit": 1000000, "source": "…", "models": { "deepseek-v4-flash": { "input": 2, "output": 8, "cacheRead": 0.5 } } }
```

金额 = `(计费输入 × input + 缓存命中 × cacheRead + 输出 × output) ÷ unit`。
被测 CLI 的默认模型名是 `deepseek-v4-flash`；费率表未列出的模型在报告里显示「未计价」，
**不会用 0 元冒充免费**。

## 判定与门禁

五维评估器（权重合计 100）：`outcome 30` / `compliance 15` / `process 15` /
`cost 15` / `changeQuality 10` / `robustness 15`。

套件门禁默认阈值：失败任务 0、unknown 任务 0、覆盖度 ≥ 0.8、仓库指纹未变；
本仓库 CI 进一步收紧为 `--require-reproducible --min-coverage 1`。

报告落盘在 `out-tasks/report/suite-report.{json,md}`，其中包含每个任务的
`evidenceLevel`、`coverage`、`gateFailures`、网络层实测用量与成本、改动清单摘要——
每一格都能回溯到具体文件与字段，而不是只给一个结论。
