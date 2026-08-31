# Zhuxing Harness

An Agent runtime where everything is a plugin — a from-scratch TypeScript implementation of an "everything-is-a-plugin" architecture.

Models, tools, sessions, sandboxes, storage, the agent loop, and CLI output are all plugins. The kernel has no privileged core; any capability can be replaced or extended through configuration.

> 中文版请见 [README.zh-CN.md](README.zh-CN.md) · For the Chinese version, see [README.zh-CN.md](README.zh-CN.md)

## Features

- **Everything is a plugin**: `kernel` only handles context / lifecycle / dependency injection / events — no agent business logic
- **Hot plug/unplug**: mount / unmount / reload at runtime, cascading consumer cleanup, circular-dependency detection, in-flight tracking
- **Traceable**: whatever the model sees is logged (append-only session log), with fork / replay / session management
- **Configurable security**: three-tier sandbox policy (`danger-full-access` default / `workspace-write` / `read-only`), credential persistence + output redaction
- **Multi-model**: OpenAI-compatible endpoints, defaults to DeepSeek (`deepseek-v4-flash` / `deepseek-v4-pro`)
- **Multi-sub-model routing & orchestration**: the orchestrator model dynamically picks a sub-model (task requirements + context analysis + real-time performance scoring), a hot-pluggable model registry, automatic fallback, and unified output format; the orchestrator delegates subtasks via the `pick_model` / `list_models` tools (see [docs/multi-model.md](docs/multi-model.md))
- **Streaming output**: `--stream` renders token-by-token
- **Developer experience**: `harness dev` watches for plugin changes and hot-reloads and re-runs automatically

## Installation

> After publishing to npm: `npm install -g @zhuxing/harness`

Run from source:

```bash
pnpm install
pnpm build
pnpm harness --help        # or node packages/cli/dist/cli.js
```

### Windows installer (NSIS, redistribution)

```bash
pnpm build
pnpm bundle
pnpm --filter @zhuxing/harness-web build:ui
node scripts/build-nsis.mjs        # generates dist-install/zhuxing-harness-setup-<version>.exe
```

Installer features:
- No admin required (installs to `%LOCALAPPDATA%\ZhuxingHarness`), automatically adds user PATH
- Bundles a portable Node runtime + Web UI + esbuild (works offline, no preinstalled Node needed)
- Start-menu shortcut, uninstaller (removes files and PATH)
- Ready to use after install: `harness run` / `harness web`

> Build tools (NSIS 3.10, portable Node 22) live in `tools/` (gitignored); download them there before the first build.

## Quick Start

### Web UI (Chat / Works / Deliverables)

```bash
harness web                 # starts the Web UI, default http://127.0.0.1:3080
harness web --port 8080     # specify a port
```

Open the browser and configure the API Key / model / workspace in «Settings», then you can chat and watch tool calls and deliverables in real time.

### Command line

```bash
# 1. Configure credentials (one-time, interactive)
harness login

# 2. Run your first task
harness run "Summarize the structure of the current directory"

# 3. Attach a plugin (via patch config)
harness run -p examples/hello-plugin.patch.yml "Use the hello tool to greet"
```

Environment self-check: `harness doctor [--network]`

## Command Overview

| Command | Description |
| --- | --- |
| `harness run` | Run an agent task (progress output / `--json` / `--stream` / `--timing`) |
| `harness dev` | Dev mode: watch plugin changes, hot-reload and re-run |
| `harness login` / `harness config` | Credential & configuration persistence |
| `harness session ls/show/rm` | Session management (JSONL persistence) |
| `harness models list/stats` | Multi-sub-model management (list / real-time performance metrics) |
| `harness validate` | Validate plugin definitions |
| `harness create-plugin` / `install` | Plugin scaffolding / local install |
| `harness list` | List the plugins resolved from configuration |
| `harness doctor` | Environment self-check |
| `harness completion` | Shell completion |
| `harness version` | Version number |

## Plugin Development (30-second quick start)

```ts
import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  const unregister = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools').register(
    defineTool({
      name: 'hello',
      description: 'Say hello',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      execute: (args) => ({ text: `Hello, ${String(args.name)}!` }),
    }),
  )
  ctx.effect(unregister) // automatically cleaned up on unload
}
```

See the full example in [examples/hello-plugin](examples/hello-plugin). Generate scaffolding with `harness create-plugin my-plugin`.

## Architecture

```
kernel (Context / Lifecycle / DI / Event / Service)
  ├── config   (profile/bundle/patch layered + TS transpile cache)
  ├── session  (append-only event log / fork / JSONL file storage)
  ├── agent    (turn/step loop, agent/* interceptors, streaming passthrough)
  ├── tools    (registry + execution pipeline: intercept -> sandbox -> timeout-retry)
  ├── sandbox  (three-tier permission policy)
  ├── llm      (unified interface + OpenAI-compatible endpoint + SSE streaming)
  └── sdk      (aggregated exports + DSL)
cli —— composition entry (all base-bundle capabilities are plugins, fully replaceable)
```

## Documentation

- [docs/quickstart.md](docs/quickstart.md) — Quick start (run it in 5 minutes) · 中文 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)
- [docs/cli.md](docs/cli.md) — CLI command reference · 中文 [docs/cli.zh-CN.md](docs/cli.zh-CN.md)
- [docs/configuration.md](docs/configuration.md) — Configuration (credentials / patch / profile / sandbox) · 中文 [docs/configuration.zh-CN.md](docs/configuration.zh-CN.md)
- [docs/plugins.md](docs/plugins.md) — Plugin development guide · 中文 [docs/plugins.zh-CN.md](docs/plugins.zh-CN.md)
- [docs/multi-model.md](docs/multi-model.md) — Multi-sub-model routing & orchestration · 中文 [docs/multi-model.zh-CN.md](docs/multi-model.zh-CN.md)
- [docs/security.md](docs/security.md) — Security model · 中文 [docs/security.zh-CN.md](docs/security.zh-CN.md)
- [PLAN.md](PLAN.md) — Design, milestones, and commercialization roadmap · 中文 [PLAN.zh-CN.md](PLAN.zh-CN.md)
- [REPORT.md](REPORT.md) — Optimization results and test findings · 中文 [REPORT.zh-CN.md](REPORT.zh-CN.md)

## License

Dual license (source-available · free for non-commercial use · paid commercial license)

[View LICENSE](LICENSE) · 中文 [LICENSE](LICENSE)
