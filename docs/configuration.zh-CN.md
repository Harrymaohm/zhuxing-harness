# 配置

## 凭证与用户配置

配置文件：`~/.zhuxing-harness/config.json`（权限 600）。可用 `HARNESS_CONFIG` 环境变量覆盖路径。

推荐用 `harness login` 交互式配置；也可手动写入：

```json
{
  "apiKey": "sk-xxxx",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-flash",
  "workspace": "/path/to/project",
  "level": "workspace-write"
}
```

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | API Key（优先级高于配置文件） |
| `HARNESS_CONFIG` | 配置文件路径 |
| `HARNESS_SESSION_DIR` | 会话持久化目录 |

### `.env`

`run` / `dev` 自动加载工作区 `.env`（`KEY=VALUE`），**不覆盖**已存在的环境变量。

### 覆盖优先级

命令行参数 > 环境变量 > 配置文件 > 内置默认值

## 插件接入：profile / bundle / patch

三层组合模型（借鉴 DeepSeek Harness）：

- **bundle**：一组插件（`plugins:` 列表）
- **profile**：引用多个 bundle + 追加 patch
- **patch**：对插件列表的覆盖操作

```yaml
# patch 文件（最常用）
plugins:
  - id: hello-plugin
    path: ./hello-plugin/src/index.ts
    config: { key: value }   # 可选，传给插件的 ctx.config
```

```yaml
# profile 文件
name: my-profile
bundles:
  - ./bundle-a.yml
  - ./bundle-b.yml
patch:
  - op: replace
    id: hello-plugin
    plugin: { id: hello-plugin, path: ./hello-plugin/src/index.ts }
  - op: remove
    id: deprecated-plugin
```

patch 操作：`insert`（同 id 覆盖）/ `replace` / `remove`。

使用：

```bash
harness run -p examples/hello-plugin.patch.yml "任务"
harness list -p examples/hello-plugin.patch.yml        # 查看解析结果
```

> 相对路径以配置文件所在目录解析。

## 沙箱级别

| 级别 | 命令 | 写入 |
| --- | --- | --- |
| `danger-full-access`（默认） | 全放行 | 全放行 |
| `workspace-write` | 命令放行 | 仅工作区内路径 |
| `read-only` | 仅放行只读命令 | 全部拒绝 |

更严格的命令级控制：`deniedCommands` / `allowedCommands` 策略在沙箱插件配置中设置。

## 模型默认值

- 端点：`https://api.deepseek.com/v1`（任意 OpenAI 兼容端点可通过 `--base-url` / `config.baseUrl` 接入）
- 模型：`deepseek-v4-flash` / `deepseek-v4-pro`（DeepSeek）；也可接入 OpenAI、OpenRouter、本地 vLLM 等

## 遥测（OpenTelemetry，默认关闭）

只有配置了导出端点才会启用，未配置时不注册监听器、不起定时器、**不发起任何网络请求**：

| 环境变量 | 作用 |
| --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 信号级端点，按原样使用（如 `http://collector:4318/v1/traces`） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 基础端点，自动补 `/v1/traces`（优先级低于上面那个） |
| `OTEL_SERVICE_NAME` | resource `service.name`，缺省 `zhuxing-harness` |
| `OTEL_GENAI_CAPTURE_CONTENT` | 设为 `1` 才采集提示词/回复/工具参数与结果正文（默认不采集） |

导出遵循 OpenTelemetry GenAI 语义约定（当前为 Development，属性名可能演进），工具执行导出 `execute_tool <工具名>` span；批量 POST OTLP/JSON，插件卸载时 flush。导出失败只计数并在日志限流告警，不影响任务执行。注意 `OTEL_GENAI_CAPTURE_CONTENT=1` 会把用户内容（先经凭据脱敏）发往该 collector。

## MCP server（stdio，可选）

在用户配置（`~/.zhuxing-harness/config.json`）里加 `mcpServers`，形状与 Claude Desktop / Cursor 相同，可直接粘贴：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": { "KEY": "value" },
      "cwd": "/optional/workdir"
    }
  }
}
```

- 只支持 **stdio**（`command` / `args` / `env` / `cwd`）；写 `url` 或 `type: http|sse` 的条目会被告警并跳过
- `command` 必填且非空；server 名不得含 `__`（与 `mcp__<server>__<tool>` 命名冲突）；非法条目**逐条告警并跳过**，不影响其它 server 与 harness 启动
- 可选覆盖：`timeoutMs`（三阶段统一）/ `initTimeoutMs` / `listTimeoutMs` / `callTimeoutMs`；单个工具结果上限 `resultMaxBytes`（默认 64KB，超出截断并标注）
- 工具注册为 `mcp__<server>__<tool>`（`inputSchema` 原样作为工具 schema）；连接失败或协议版本不匹配的 server **不注册工具**
- 协议：双版本协商——现代 `2026-07-28`（`server/discover` 探测 + 每请求 `_meta` 内联版本与能力）与旧版 `2025-06-18`（`initialize` 握手 + `notifications/initialized`）；服务端回其它版本则**断开**；客户端能力声明为空（不提供 roots / sampling / elicitation）
- 风险（必读）：见 [安全模型 · MCP server](security.zh-CN.md)——接入即把第三方能力并入 agent，路径沙箱管不到它在外部进程里碰什么文件
