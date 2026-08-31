# 安全模型

## 设计原则

1. **最高权限默认**：沙箱默认 `danger-full-access`，信息查询与写操作均不受阻；可通过 `--level` 或配置降级
2. **按需降级**：对非可信环境 / 敏感目录，建议降级至 `workspace-write` 或 `read-only`
3. **凭证保护**：持久化 + 输出脱敏 + 文件权限
4. **可追溯**：模型可见的一切输入均落会话日志，可审计

## 沙箱三级策略

| 级别 | 命令执行 | 文件写入 |
| --- | --- | --- |
| `danger-full-access`（默认） | 全放行 | 全放行 |
| `workspace-write` | 命令放行 | 仅允许工作区内路径 |
| `read-only` | 仅放行只读命令；只拦截明确的写意图 | 全部拒绝 |

**read-only 只拦写意图，放行只读查询**：

- ✅ 放行：`git status/log/diff`、`grep/find/cat/head/tail/ls`、`sed` 查询（无 `-i`）、`awk` 查询、`npm view`、`pip list`、`curl` 查询（无 `-o`）、`echo $VAR`
- ⛔ 拦截：`rm/mv/cp/mkdir/touch`、`sed -i`（原地写）、`curl -o`（下载写文件）、`npm install/publish/run`、`echo > file`、`vi/vim` 编辑、`git push/commit/tag`、`wget`、`chmod/chown`、`dd/mkfs/format`

命令级精细控制：`deniedCommands`（最高优先级）/ `allowedCommands`（放行名单）。

## 凭证安全

- **存储**：`~/.zhuxing-harness/config.json`，文件权限 600
- **输入**：`harness login` 交互式输入，避免命令行明文
- **输出脱敏**：CLI 全部输出（进度/结果/轨迹/错误/doctor）经 `maskSecrets()` 打码，`sk-` 令牌显示为 `sk-***xxx`
- **环境变量**：`DEEPSEEK_API_KEY` 为备选，避免写入命令历史

> 一旦 Key 泄露到对话/日志/截图，应立即在供应商控制台轮换。

## 工具执行安全

工具执行管道统一：前置拦截（策略插件可拒绝）→ 沙箱守卫 → 超时（默认 60s）→ 重试 → 结果规范化。

带 `sandbox` 声明的工具（如 `shell`、`write_file`）在执行前自动按策略裁决。

## 插件信任边界

- 插件可读写工作区、执行命令、注入服务——**只加载可信来源的插件**
- `harness validate` 校验插件定义（依赖/服务/配置 schema）
- 热重载/卸载保证资源清理，避免悬空引用与残留

## 会话与审计

- 会话日志追加式落盘（`~/.zhuxing-harness/sessions/*.jsonl`）
- `harness session show <id>` 可回放完整轨迹（系统提示、请求、工具结果均记录）
- 日志输出统一脱敏，不落凭证

## 建议

1. 生产环境固定沙箱级别并细化 `deniedCommands`
2. 服务化/无人值守场景使用 `danger-full-access` 时务必隔离环境
3. 定期轮换 API Key；对敏感项目限制插件来源
