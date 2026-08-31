# 插件开发指南

插件是导出一个 `apply(ctx)` 函数的 TypeScript 模块。内核在加载时调用 `apply`，卸载时自动清理其注册的资源。

## 最小插件

```ts
// my-plugin/src/index.ts
import type { Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const version = '0.1.0'
export const description = '我的第一个插件'

export function apply(ctx: Context) {
  ctx.logger.info('[my-plugin] loaded')
}
```

## 三种形态

| 形态 | 用法 |
| --- | --- |
| 函数 | `export function apply(ctx)` + `export const name` |
| 对象 | `export default { name, apply(ctx) {} }` |
| 类（提供服务） | `export default class extends Service { constructor(ctx) { super(ctx, 'myService') } }` |

## 注册工具（能力即插件）

```ts
import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const inject = ['tools']          // 声明依赖，就绪后才执行 apply

export function apply(ctx: Context) {
  const tools = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools')

  const unregister = tools.register(
    defineTool({
      name: 'hello',
      description: '向用户打招呼',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      execute: (args) => ({ text: `你好，${String(args.name)}！` }),
    }),
  )

  ctx.effect(unregister)                 // 卸载/热重载时自动注销工具
}
```

### 工具执行管道

`tools.execute` 统一走：前置拦截事件 → 沙箱守卫（`sandbox` 字段声明）→ 超时重试 → 结果规范化。

```ts
execute: (args) => ({ text: '...' })          // 成功
execute: (args) => ({ error: '失败原因' })     // 失败（不会中断 Agent）
```

## ctx API

| API | 说明 |
| --- | --- |
| `ctx.logger` | 结构化日志（trace/debug/info/warn/error） |
| `ctx.config` | 插件配置（patch 中 `config:` 字段注入） |
| `ctx.provide(name, impl)` | 注册一个 Service，供其他插件 `inject` |
| `ctx.inject(name)` / `injectOptional(name)` | 注入服务（可选注入不抛错） |
| `ctx.on(event, listener)` / `once` / `emit` | 事件订阅与派发；监听器返回 `false` 可拒绝事件 |
| `ctx.effect(disposer)` | 注册可逆副作用，卸载时逆序自动执行（幂等） |
| `ctx.track(promise)` | 登记 in-flight 异步操作，卸载时等待完成（带超时） |

## 事件清单

| 事件 | 时机 | 拦截 |
| --- | --- | --- |
| `agent/pre-step` | 每次模型请求前 | 返回 `false` 拒绝本次请求 |
| `agent/post-step` | 每次 step 结束后 | — |
| `tools/before-exec` | 工具执行前 | 返回 `false` 拦截 |
| `tools/after-exec` | 工具执行后 | — |
| `plugin/mounted` / `plugin/unmounted` | 插件生命周期 | — |

## 声明依赖与提供服务

```ts
export const inject = ['llm', 'tools']    // 依赖：就绪后才 apply
export const provides = ['my-service']    // 提供服务名（依赖拓扑/环检测用）
```

- 依赖未就绪时插件进入 pending，服务注册后自动挂载
- 卸载服务提供者会**级联卸载**其消费者
- 循环依赖会被检测并拒绝

## 生命周期与热重载

- 卸载顺序：消费者先于提供者；`ctx.effect` 逆序执行
- `ctx.effect` 必须幂等（热重载会反复执行）
- 工具注册务必用 `ctx.effect(unregister)` 绑定清理，否则热重载会残留

## 开发工作流

```bash
# 1. 脚手架
harness create-plugin my-plugin

# 2. 校验
harness validate my-plugin/src/index.ts

# 3. 接入并运行
harness run -p my-plugin.patch.yml "任务"

# 4. 热重载开发
harness dev -p my-plugin.patch.yml "任务"   # 改文件自动重载重跑
```

## 参考示例

- [examples/hello-plugin](../../examples/hello-plugin) — 工具注册 + 生命周期清理
- [examples/hello-plugin.patch.yml](../../examples/hello-plugin.patch.yml) — 接入配置
