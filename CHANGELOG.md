# Changelog

This project follows [Semantic Versioning](https://semver.org/).

> 中文版请见 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) · For the Chinese version, see [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)

## [Unreleased]

### Web settings panel: main model / sub-models / image model / runtime

- Settings modal upgraded to a sectioned (tabbed) layout: main model (Key/endpoint/model name), sub-models (card-based add/remove: ID/model name/display name/context window/capability tags/separate endpoint & Key), image model (model/endpoint/Key/size), runtime (workspace/sandbox-level dropdown)
- New `harness-image-tools` plugin: registers a `generate_image` tool (OpenAI-compatible `/images/generations`, supports url and base64 responses) after configuring `imageModel`; both CLI run/dev and Web pass through the `imageModel` config
- Key security: `GET /api/config` redacts apiKey for main/sub-models/image model entirely; on save, unchanged keys are not echoed back, and the server merges and keeps the old value per model id (added regression tests)

### Multi-sub-model routing & orchestration (`@zhuxing/harness-model-router`)

- New package `packages/model-router`: model registry (hot-pluggable, `register` returns a disposer), real-time performance monitoring (sliding window: success rate/latency/token/cost), selection algorithm (task intent + context adaptation + performance scoring, configurable weights), unified interaction entry (`ModelRouter` implements `ChatProvider`, automatic fallback on failure), inter-model communication protocol (`ModelOrchestrator.delegate/listModels`)
- `bundle` adds a `harness-model-router` plugin: multi-model registration via `config.models`, registers `pick_model` / `list_models` tools for the orchestrator model to dynamically delegate subtasks; provides services `modelRegistry/modelMonitor/modelSelector/modelRouter/orchestrator`; plugin unload automatically unregisters all sub-models
- CLI: new `harness models list/stats`; `run`/`dev` support `--models <json>` and `--model-id <id>` (explicitly select a sub-model, retaining monitoring and fallback through the router)
- Web: `config.models` passthrough; new `GET /api/models`
- Docs: `docs/multi-model.md`; publish topology order includes model-router (13 packages)

### Windows installer (NSIS, redistribution)

- `scripts/build-nsis.mjs` + `scripts/nsis/installer.nsi`: then generates `zhuxing-harness-setup-<version>.exe`
- Bundles portable Node 22 + single-file CLI + Web UI static assets + esbuild runtime, no admin required (installs to `%LOCALAPPDATA%`), automatically adds user PATH, start-menu shortcut, uninstaller
- `scripts/build-dist.mjs`: assembles the installer content directory (avoids Node `cpSync` native crashes under CJK paths via a custom recursive copy)
- Full silent install/uninstall/run smoke verification passed (version / doctor / validate / web / uninstall)

### Iteration data retention and final folding

- All intermediate data from the iteration (temporary data, process variables, intermediate results, step info) is fully preserved in the session log and keeps participating in later iterations (`AgentLoop` accumulates all messages between steps + logs tool arguments/results in full)
- **Folding happens only when producing the final output**: new `foldResult()` (agent package) generates the delivery summary; CLI `--summary` prints the folded summary while full data remains available via `harness session show <id>`; the Web UI folds long results by default and expands on click
- Data-integrity tests: verify intermediate arguments/results are fully preserved, intermediate results participate in later iterations, and folding deletes no data

### Security policy optimizations

- Sandbox read-only changed to "only block explicit write intents, allow read-only queries": fixed `sed` / `awk` queries being mistakenly blocked (`sed -n`/`awk '{print}'` and similar now run; `sed -i` in-place writes are still blocked)
- Explicit read allow-list: `git status/log/diff`, `grep/find/cat/head/tail`, `npm view`, `pip list`, `curl` (without `-o`), `echo $VAR`, etc.
- Docs (`docs/security.md`) updated with finer-grained level behavior descriptions

### Added

- **Web UI (Chat / Works / Deliverables)**: `harness web` starts (default 3080); HTTP + SSE streaming API (health/sessions/config/chat); React front-end (streaming tokens, tool-progress cards, session sidebar, deliverables area, settings)
- **`@zhuxing/harness-bundle`** standalone package: base plugin composition layer (shared by cli and web, removes circular dependency)
- CLI `web` command; publish order updated to a 12-package topology

## [0.1.0] - 2026-08-20

### Engineering & release (commercialization)

- Release toolchain: `scripts/publish.mjs` (topological publish + publishConfig public + pre-publish `pnpm check` gate), `scripts/bump.mjs` (unified version), `scripts/bundle-cli.mjs` (single-file binary)
- Aggregate installer package `@zhuxing/harness`: `npm i -g` gives you a global `harness` in one command
- Quality gate `pnpm check`, CI (GitHub Actions, ubuntu+windows × node20/22), git version control, README / LICENSE(MIT) / CHANGELOG
- User docs: `docs/` (quickstart / cli / configuration / plugins / security)
- Exit-code spec (0/1/2), `harness version` / `harness doctor` environment self-check

### Added (first runnable version, M0–M5 milestones)

- **Kernel (kernel)**: Context / lifecycle / dependency injection / event bus / Service registration; hot-pluggable (mount/unmount/reload, cascading cleanup, circular-dependency detection, in-flight tracking, pending-wait timeout)
- **Config (config)**: profile/bundle/patch layered merge; TS plugin esbuild transpile + content-hash cache (≈28x hot-start speedup)
- **Session (session)**: append-only event log, fork / replay; in-memory and JSONL file storage; event-limit trimming options
- **Agent (agent)**: turn/step loop, `agent/*` and `tools/*` intercept events, streaming passthrough (onToken)
- **Tool** (tools): registry + execution pipeline (pre-interceptor → sandbox guard → timeout-retry → result normalization); `register` returns a disposer for lifecycle binding
- **Sandbox (sandbox)**: three-tier policy read-only / workspace-write / danger-full-access, structured permission errors
- **Model (llm)**: unified ChatProvider interface; OpenAI-compatible endpoint; SSE streaming (tool_calls incremental accumulation, usage)
- **SDK (sdk)**: aggregated exports + `defineTool` DSL + `createOpenAIProvider`
- **CLI (cli)**: `run / dev / login / config / session / validate / create-plugin / install / list / doctor / completion / version`
  - Real-time progress output, `--stream` token-by-token, `--json`, `--timing`, `--verbose`
  - Credential persistence (`~/.zhuxing-harness/config.json`, 600) + `.env` loading + output redaction
  - Structured error classification (AUTH/NETWORK/CONFIG/PERMISSION/PLUGIN/TIMEOUT/UNKNOWN) with fix hints
  - Exit-code spec: 0 success / 1 runtime error / 2 usage error
  - Default sandbox level read-only (secure by default)
- **Engineering**: pnpm workspace, TypeScript strict, quality gate (`pnpm check`), performance benchmark (`node scripts/bench.mjs`), example plugins

### Quality

- 79 tests (unit + hot-plug stress + end-to-end), `pnpm check` passes all in one run
- Real-model closed-loop verification (DeepSeek v4-flash): plugin tools + built-in tool orchestration, session replay, streaming output, dev hot reload
