# 多子模型路由与编排

「一切皆插件」体系下的多模型能力：主编排模型（主模型）根据任务需求、上下文与实时性能指标，动态选择并委派子模型执行子任务。全部能力以 `harness-model-router` 插件形态挂载，可整体替换或卸载。

## 架构

```
主编排模型（主模型，id: default）
        │  调用工具 pick_model / list_models
        ▼
ModelOrchestrator（模型间通信协议：delegate / listModels）
        │
        ▼
ModelRouter（统一交互入口，实现 ChatProvider）
   ├── ModelSelector   选择算法（任务意图 + 上下文适配 + 性能评分）
   ├── ModelRegistry   模型注册表（热插拔：register 返回 disposer）
   └── ModelMonitor    实时性能监控（滑动窗口：成功率/延迟/token/成本）
        │
        ▼
子模型 A / B / C …（OpenAI 兼容 provider，统一输出 ChatResult）
```

- **插件管理框架**：`ModelRegistryImpl` 支持运行期注册/注销，`register()` 返回 disposer，绑定 `ctx.effect` 后随插件卸载自动清理（热插拔安全）。
- **模型选择算法**：评分 = 能力匹配 ×0.5 + 上下文适配 ×0.2 + 性能指标 ×0.3（权重可配置）。任务意图基于预置中英关键词词表分析；上下文按字符数估算 token 与模型窗口比对；性能取滑动窗口成功率与延迟。
- **模型间通信协议**：编排模型调用 `pick_model` 工具委派子任务，返回统一格式 `{ ok, modelId, content, usage, latencyMs, estCost, error? }`；`list_models` 返回可用模型与实时指标供决策。
- **统一交互接口**：`ModelRouter` 实现 `ChatProvider`（chat/stream），无论选中哪个子模型，输出均为一致的 `ChatResult`（实际模型 id 附在 `raw.__modelId`）。
- **失败降级**：首选子模型失败时自动尝试次优候选（`fallback` 默认开启）。

## 配置子模型

持久化配置（`~/.zhuxing-harness/config.json` 的 `models` 字段，或 `harness config set models '<json>'`）：

```json
{
  "models": [
    { "id": "coder", "model": "deepseek-coder", "capabilities": ["code"], "contextWindow": 64000 },
    { "id": "fast", "model": "deepseek-v4-flash", "capabilities": ["fast", "general"], "contextWindow": 8000, "costPer1k": 0.001 },
    { "id": "long", "model": "deepseek-v4-pro", "capabilities": ["analysis", "long-context"], "contextWindow": 200000, "baseUrl": "https://api.deepseek.com/v1" }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `id` | 子模型唯一标识（必填） |
| `model` | OpenAI 兼容模型名（必填） |
| `capabilities` | 能力标签：`code` / `reasoning` / `creative` / `analysis` / `fast` / `cheap` / `long-context` / `general` |
| `contextWindow` | 上下文窗口（token），用于上下文适配评分 |
| `costPer1k` | 每千 token 成本估算（元），用于成本监控 |
| `baseUrl` / `apiKey` | 端点与密钥（缺省回退主配置） |
| `timeoutMs` | 请求超时 |

命令行临时覆盖：

```bash
harness run --models '[{"id":"coder","model":"deepseek-coder","capabilities":["code"]}]' "写一个排序函数"
```

## 使用

```bash
harness models list                 # 列出已注册子模型
harness models stats                # 实时性能指标（成功率/延迟/调用/token/成本）
harness run --model-id coder "重构这段代码"   # 显式指定子模型（跳过自动选择）
harness run "总结这个仓库"            # 自动选择：编排模型可调用 pick_model 委派子任务
```

Web 端：`config.models` 自动生效；`GET /api/models` 返回当前配置。Web UI「设置」面板提供分区式配置：

- **主模型**：API Key / Base URL / 模型名（主编排模型）
- **子模型**：卡片式增删，每项含模型 ID、模型名、显示名称、上下文窗口、能力标签（点选）、独立端点与 Key（缺省回退主配置）
- **生图模型**：模型名 / 端点 / Key / 默认尺寸；配置后 Agent 获得 `generate_image` 工具（OpenAI 兼容 `/images/generations`）
- **运行环境**：工作区、沙箱级别

密钥安全：`GET /api/config` 对主 Key、子模型 Key、生图 Key 全部脱敏返回；前端保存时未修改的密钥不会回传，服务端按模型 id 合并保留旧值。

## 编程接口

```ts
import {
  ModelRegistryImpl, ModelMonitorImpl, ModelSelectorImpl,
  ModelRouterImpl, ModelOrchestratorImpl,
} from '@zhuxing/harness-model-router'

const registry = new ModelRegistryImpl()
const monitor = new ModelMonitorImpl()
const selector = new ModelSelectorImpl(registry, monitor)
const router = new ModelRouterImpl(registry, monitor, selector)

const dispose = registry.register({ id: 'coder', capabilities: ['code'] }, provider)
const result = await router.chat(messages)          // 自动选择 + 降级
const orchestrator = new ModelOrchestratorImpl(registry, monitor, router)
const sub = await orchestrator.delegate({ task: '计算 1+1' })  // 统一格式结果
dispose()                                            // 热插拔：注销子模型
```

bundle 内服务名：`modelRegistry` / `modelMonitor` / `modelSelector` / `modelRouter` / `orchestrator`。
