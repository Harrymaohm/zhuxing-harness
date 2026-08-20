# 筑星 Harness（Zhuxing Harness）

可随意接入插件的 Agent 运行时 —— 借鉴 DeepSeek Harness「一切皆插件」设计，从零自研的 TypeScript 实现。

模型、工具、会话、沙箱、存储、Agent 循环、CLI 输出全部是插件；内核无特权核心，任何能力都可通过配置替换或扩展。

## 特性

- **一切皆插件**：`kernel` 只负责上下文/生命周期/依赖注入/事件，无 Agent 业务逻辑
- **热插拔**：运行时挂载/卸载/重载，级联清理消费者、循环依赖检测、in-flight 追踪
- **可追溯**：模型可见即记录（追加式会话日志），支持 fork / replay / 会话管理
- **安全可配置**：沙箱三级策略（danger-full-access 默认 / workspace-write / read-only），凭证持久化 + 输出脱敏
- **多模型**：OpenAI 兼容端点，默认 DeepSeek（`deepseek-v4-flash` / `deepseek-v4-pro`）
- **流式输出**：`--stream` 逐 token 渲染
- **开发体验**：`harness dev` 监听插件变化自动热重载并重跑

## 安装

> 发布到 npm 后：`npm install -g @zhuxing/harness`

当前源码运行：

```bash
pnpm install && pnpm build
pnpm harness --help        # 或 node packages/cli/dist/cli.js
```

## 快速开始

### Web UI（对话 / 工作 / 交付）

```bash
harness web                 # 启动 Web UI，默认 http://127.0.0.1:3080
harness web --port 8080     # 指定端口
```

浏览器打开后在「设置」中配置 API Key / 模型 / 工作区，即可对话并实时观察工具调用与交付结果。

### 命令行

```bash
# 1. 配置凭证（一次性，交互式）
harness login

# 2. 运行第一个任务
harness run "总结当前目录的结构"

# 3. 接入一个插件（通过 patch 配置）
harness run -p examples/hello-plugin.patch.yml "调用 hello 工具打个招呼"
```

环境自检：`harness doctor [--network]`

## 命令总览

| 命令 | 说明 |
| --- | --- |
| `harness run` | 运行 Agent 任务（进度输出 / `--json` / `--stream` / `--timing`） |
| `harness dev` | 开发模式：监听插件变化自动热重载并重跑 |
| `harness login` / `harness config` | 凭证与配置持久化 |
| `harness session ls/show/rm` | 会话管理（JSONL 持久化） |
| `harness validate` | 校验插件定义 |
| `harness create-plugin` / `install` | 插件脚手架 / 本地安装 |
| `harness list` | 列出配置解析出的插件 |
| `harness doctor` | 环境自检 |
| `harness completion` | shell 补全 |
| `harness version` | 版本号 |

## 插件开发（30 秒上手）

```ts
import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  const unregister = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools').register(
    defineTool({
      name: 'hello',
      description: '打招呼',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: (args) => ({ text: `你好，${String(args.name)}！` }),
    }),
  )
  ctx.effect(unregister) // 卸载时自动清理
}
```

完整示例见 [examples/hello-plugin](examples/hello-plugin)。生成脚手架：`harness create-plugin my-plugin`。

## 架构

```
kernel（Context/Lifecycle/DI/Event/Service）
  ├── config   （profile/bundle/patch 分层 + TS 转译缓存）
  ├── session  （追加式事件日志 / fork / JSONL 文件存储）
  ├── agent    （turn/step 循环、agent/* 拦截、流式透传）
  ├── tools    （注册表 + 执行管道：拦截→沙箱→超时重试）
  ├── sandbox  （三级权限策略）
  ├── llm      （统一接口 + OpenAI 兼容端点 + SSE 流式）
  └── sdk      （聚合导出 + DSL）
cli —— 组合入口（base bundle 全部能力均为插件，可整体替换）
```

## 文档

- [docs/quickstart.md](docs/quickstart.md) — 快速开始（5 分钟跑通）
- [docs/cli.md](docs/cli.md) — CLI 命令参考
- [docs/configuration.md](docs/configuration.md) — 配置（凭证 / patch / profile / 沙箱）
- [docs/plugins.md](docs/plugins.md) — 插件开发指南
- [docs/security.md](docs/security.md) — 安全模型
- [计划书.md](计划书.md) — 设计、里程碑、商用化路线图
- [优化报告.md](优化报告.md) — 优化内容与测试结果

## 许可

[MIT](LICENSE)
