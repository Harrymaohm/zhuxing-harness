# CLI 参考

退出码：`0` 成功 · `1` 运行时错误 · `2` 用法错误

## 全局

```bash
harness --help | -h     # 帮助
harness --version | -v  # 版本号
```

## run —— 运行 Agent 任务

```bash
harness run [选项] "任务描述"
```

| 选项 | 说明 |
| --- | --- |
| `-p, --patch <file>` | patch 覆盖层，可多次 |
| `--profile <file>` | profile 组合文件 |
| `--api-key <key>` | API Key（默认：配置 → 环境变量） |
| `--base-url <url>` | OpenAI 兼容端点（默认 `https://api.deepseek.com/v1`） |
| `--model <name>` | 模型名（默认 `deepseek-v4-flash`） |
| `-w, --workspace <dir>` | 工作区（默认：配置或当前目录） |
| `--level <级别>` | `read-only` / `workspace-write` / `danger-full-access`（默认 `danger-full-access`） |
| `--max-steps <n>` | 最大步数（默认 20） |
| `--temperature <t>` | 采样温度 |
| `--system-prompt <s>` | 自定义系统提示 |
| `--session-dir <dir>` | 会话持久化目录（默认 `~/.zhuxing-harness/sessions`） |
| `--stream` | 逐 token 流式输出 |
| `--json` | 结构化 JSON 输出 |
| `--summary` | 最终输出折叠为交付摘要（完整数据保留在会话日志） |
| `--timing` | 打印阶段耗时 |
| `--verbose` | 打印完整会话轨迹 |
| `--log-level <l>` | `trace`/`debug`/`info`/`warn`/`error` |

示例：

```bash
harness run "修复 src/index.ts 的 bug" --level workspace-write
harness run --json --timing "总结仓库"           # 脚本消费
harness run --stream "解释什么是 Agent harness"   # 流式
```

`--json` 输出结构：`{ ok, content, steps, finishedReason, sessionId, timing? }`

## dev —— 开发模式（热重载）

```bash
harness dev [选项] "任务描述"
```

监听 patch 插件入口文件，变化时自动卸载 → 重挂 → 重跑任务。`Ctrl-C` 退出。

## login —— 交互式配置

```bash
harness login
```

依次输入 API Key / Base URL / 模型 / 工作区 / 沙箱级别，写入 `~/.zhuxing-harness/config.json`。

## config —— 配置管理

```bash
harness config list                      # 列出（apiKey 自动脱敏）
harness config get <key>
harness config set <key> <value>
harness config rm <key>
```

常用键：`apiKey` / `baseUrl` / `model` / `workspace` / `level`。

## session —— 会话管理

```bash
harness session ls                       # 列出会话（前缀 id + 事件数 + 时间）
harness session show <id或前缀>          # 查看会话轨迹
harness session rm <id或前缀>            # 删除会话
```

会话持久化于 `~/.zhuxing-harness/sessions/*.jsonl`（`HARNESS_SESSION_DIR` 可覆盖）。

## validate —— 校验插件

```bash
harness validate <插件路径>              # 支持 .ts / .js
```

输出插件元信息与开发期建议。

## create-plugin —— 脚手架

```bash
harness create-plugin <名称>
```

生成含工具注册 / 事件订阅 / 生命周期清理三种能力示例的插件模板。

## install —— 安装本地插件

```bash
harness install <插件源目录> [--as <名称>]
```

复制到 `plugins/` 并输出接入配置片段。`plugins/` 为本地产物（gitignore）。

## list —— 解析插件配置

```bash
harness list [--patch <file>] [--profile <file>]
```

## doctor —— 环境自检

```bash
harness doctor [--network]
```

检查：Node 版本、API Key（脱敏）、会话目录可写、默认沙箱级别、模型默认值；`--network` 额外验证端点连通性。

## completion —— shell 补全

```bash
harness completion bash | zsh
```

## 配置覆盖优先级（run/dev）

命令行参数 > 环境变量（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）> 配置文件 > 默认值
