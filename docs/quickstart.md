# 快速开始

5 分钟内跑通第一个 Agent 任务。

## 1. 安装

### 方式 A：源码运行（当前）

```bash
git clone <repo>
pnpm install
pnpm build
pnpm harness --help        # 或 node packages/cli/dist/cli.js --help
```

### 方式 B：全局命令（发布后）

```bash
npm install -g @zhuxing/harness
harness --help
```

### 方式 C：单文件二进制（无需 Node 环境）

```bash
pnpm bundle                # 生成 dist-bin/harness.cjs
node dist-bin/harness.cjs version
```

## 2. 配置凭证

```bash
harness login
```

交互式输入 API Key（默认 DeepSeek）、Base URL、模型、工作区、沙箱级别。
凭证持久化到 `~/.zhuxing-harness/config.json`（权限 600），输出自动脱敏。

也可以使用环境变量（无需 login）：

```bash
export DEEPSEEK_API_KEY=sk-xxxx
# 或在工作区根目录创建 .env：DEEPSEEK_API_KEY=sk-xxxx
```

## 3. 环境自检

```bash
harness doctor            # 版本/Key/目录/默认级别
harness doctor --network  # 额外验证模型端点连通性
```

## 4. 运行第一个任务

```bash
harness run "总结当前目录的结构"
```

模型会调用内建工具（`list_dir` / `read_file` / `shell` / `write_file`）完成任务，实时显示进度：

```
▶ 第 1 步：调用模型…
  ↳ 工具 list_dir({"path":"."})…
  ✓ list_dir → … 
▶ 第 2 步：调用模型…
✓ 步骤完成
```

### 常用选项

| 选项 | 说明 |
| --- | --- |
| `--stream` | 逐 token 流式输出模型回答 |
| `--json` | 输出结构化 JSON（供脚本） |
| `--timing` | 打印各阶段耗时 |
| `--verbose` | 打印完整会话轨迹 |
| `-p, --patch <file>` | 接入外部插件 |
| `--level <级别>` | 沙箱级别（默认 read-only） |
| `-w, --workspace <dir>` | 工作区 |

## 5. 接入一个插件

```bash
# 校验插件
harness validate examples/hello-plugin/src/index.ts

# 通过 patch 配置接入并运行
harness run -p examples/hello-plugin.patch.yml "调用 hello 工具打个招呼"
```

## 6. 下一步

- [CLI 参考](cli.md)
- [配置](configuration.md)
- [插件开发](plugins.md)
- [安全模型](security.md)
