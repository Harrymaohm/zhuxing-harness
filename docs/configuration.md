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
| `read-only`（默认） | 仅放行只读命令 | 全部拒绝 |
| `workspace-write` | 命令放行 | 仅工作区内路径 |
| `danger-full-access` | 全放行 | 全放行 |

更严格的命令级控制：`deniedCommands` / `allowedCommands` 策略在沙箱插件配置中设置。

## 模型默认值

- 端点：`https://api.deepseek.com/v1`（任意 OpenAI 兼容端点可通过 `--base-url` / `config.baseUrl` 接入）
- 模型：`deepseek-v4-flash` / `deepseek-v4-pro`（DeepSeek）；也可接入 OpenAI、OpenRouter、本地 vLLM 等
