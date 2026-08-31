# Zhuxing Harness Comprehensive Optimization Report

> Date: 2026-08-20
> Scope: code performance, resource utilization, user experience, system stability
> Conclusion: **all optimization measures have been implemented and verified through testing; performance and experience meet expectations.**

---

## 1. Optimization goals

| Dimension | Goal |
| --- | --- |
| Code performance | speed up plugin-loading startup; avoid repeated transpilation and import cache invalidation |
| Resource utilization | session memory can be constrained; transpiled artifacts reusable; no repeated building on concurrent loading |
| User experience | second-level command entry; one login avoids re-passing the Key repeatedly; real-time progress during runs; structured, parseable output; self-serviceable errors |
| System stability | unified error classification; guaranteed resource cleanup on failure; safe-by-default level; masked credential output |

---

## 2. Optimization content and implementation process

### 2.1 Code performance

**P-1 Plugin transpilation content-hash cache** ([loader.ts](file:///e:/筑星Harness/packages/config/src/loader.ts))
- Current problem: every `run/validate` re-runs the esbuild transpilation, and `?t=timestamp` forces import cache invalidation.
- Implementation: the artifact filename is changed to "source filename-content-SHA256(12 chars).mjs"; if the content is unchanged, skip the build and import directly (a stable URL reuses the module cache); added a single-process concurrency mutex (`withBuildLock`); concurrent loading of the same plugin does not rebuild.
- Expected effect: hot startup skips esbuild; significant gains with multiple/large plugins.

**P-2 CLI stage timing** ([cli.ts](file:///e:/筑星Harness/packages/cli/src/cli.ts))
- Added `--timing`: outputs five-stage timings — config parsing / mounting / plugin loading / Agent running / total — providing a tool for performance observation.

### 2.2 Resource utilization

**R-1 Session event limit pruning** ([session](file:///e:/筑星Harness/packages/session/src/index.ts))
- `MemorySessionStore` adds a `maxEventsPerSession` option that prunes the oldest events when exceeded; unlimited by default (preserving the append-only iron rule), enabled by the user per scenario.
- Avoids unbounded memory growth of very long sessions.

**R-2 Transpiled artifact reuse**
- The content-hash cache simultaneously reduces duplicate disk artifacts and CPU transpilation overhead (see P-1).

### 2.3 User experience

**U-1 Global command entry** ([package.json](file:///e:/筑星Harness/package.json))
- The root project adds `bin: { harness: "packages/cli/dist/cli.js" }` (globally available after `npm link`) and the `pnpm harness` shortcut script; no longer needs `node packages/cli/dist/cli.js`.

**U-2 Login and config persistence** ([config-store.ts](file:///e:/筑星Harness/packages/cli/src/config-store.ts))
- Added `harness login`: interactively collects API Key / Base URL / model / workspace / sandbox level, writing to `~/.zhuxing-harness/config.json` (permission 600).
- Added `harness config get|set|list|rm`; supports the `HARNESS_CONFIG` environment variable to override the path (tests/multi-environment).
- `run` automatically reads config and the workspace `.env` (without overriding existing environment variables), removing the need to pass arguments each time.

**U-3 Real-time progress output** ([output.ts](file:///e:/筑星Harness/packages/cli/src/output.ts))
- During `run`, subscribes to `agent/*` and `tools/*` events, displaying "calling model / tool call / tool result / step completed" in real time, eliminating long silent periods; color is automatically disabled on non-TTY, keeping pipe output clean.

**U-4 Structured output**
- `--json`: outputs `{ ok, content, steps, finishedReason, sessionId, timing }`, for script consumption.
- Default output is sectional (result / step summary); the full trace is printed only with `--verbose` (reducing noise).

**U-5 Scaffolding enhancements** (`create-plugin`)
- The template demonstrates three capabilities by default: tool registration (with schema/required), event subscription, and reversible side effects, with dependency declarations injected.

**U-6 Validation suggestions** (`validate`)
- After validation passes, provides development-time suggestions (missing description, plugin with neither dependencies nor services, etc.).

### 2.4 System stability

**S-1 Structured error classification** ([errors.ts](file:///e:/筑星Harness/packages/kernel/src/errors.ts))
- Added `HarnessError { code, hint }`, categorized as: `AUTH / NETWORK / CONFIG / PERMISSION / PLUGIN / TIMEOUT / UNKNOWN`; `HarnessError.from()` heuristically classifies existing errors.
- Sandbox permission rejection now throws a `PERMISSION` error with a fix hint; the CLI uniformly catches and outputs "error + hint".

**S-2 Runtime error boundary**
- The `cmdRun` body is wrapped in `try/finally`; any path (including plugin mount failures, Agent exceptions) guarantees `app.dispose()` cleans up resources.

**S-3 Default safe level**
- The `run` default sandbox level changed from `workspace-write` to `read-only` (writes require explicit elevation).

**S-4 Credential output masking**
- `maskSecrets()`: masks `sk-` prefix tokens and `KEY=VALUE` forms; all CLI output (progress, results, traces, errors) uniformly goes through masking.

---

## 3. Test results

**Full regression: all 63 tests pass** (`pnpm -r test` + `pnpm test:e2e`), typecheck passes.

New tests (14 items):

| Test file | Coverage |
| --- | --- |
| [errors.test.ts](file:///e:/筑星Harness/packages/kernel/__tests__/errors.test.ts) (7) | error classification AUTH/NETWORK/TIMEOUT/PERMISSION/PLUGIN/UNKNOWN; masking sk- and KEY=VALUE, no false positives on short tokens, empty input safe |
| [cache.test.ts](file:///e:/筑星Harness/packages/config/__tests__/cache.test.ts) (2) | content-hash cache: same content reuses artifact, modification generates a new artifact; concurrent loading does not rebuild |
| [prune.test.ts](file:///e:/筑星Harness/packages/session/__tests__/prune.test.ts) (2) | event-limit prunes the oldest events; unlimited by default |
| [config-store.test.ts](file:///e:/筑星Harness/packages/cli/__tests__/config-store.test.ts) (3) | config save/load round-trip; .env loading without overriding existing variables; missing config returns an empty object |

The existing 49 tests (kernel/hot-swap stress/tools/session/Agent/LLM/sandbox/config/CLI/SDK/end-to-end) all continue to pass, with no regressions.

---

## 4. Performance comparison (measured)

Benchmark script: [bench.mjs](file:///e:/筑星Harness/scripts/bench.mjs) (`node scripts/bench.mjs`, local Node 22 / Windows)

### 4.1 Plugin transpilation startup (loadPluginModule)

| Metric | Before optimization | After optimization (cache hit) | Speedup |
| --- | --- | --- | --- |
| Min time | — (transpiled every time) | 0.7 ms | — |
| Avg time | 22.5 ms (cold) | 0.8 ms (hot) | **≈ 28x** |

(Cold start includes esbuild transpilation; hot start skips the build when content is unchanged, including import execution.)

### 4.2 CLI process-level (validate path, including Node startup overhead)

| Scenario | Time |
| --- | --- |
| First run (cold, includes transpilation) | 199.1 ms |
| Second run (hot, cache hit) | 190.3 ms |
| Transpilation savings | 8.8 ms (Node startup and module loading dominate the process cost) |

> Note: transpilation is a small share for a single plugin; in multi-plugin / large-plugin / `dev` hot-reload scenarios, cache gains scale linearly (bench shows ~22ms/plugin for a single plugin's transpilation).

### 4.3 Real model run (DeepSeek v4-flash, `--json --timing`)

```
total: 2546ms = configParse 25ms + mount 3ms + pluginLoad 83ms + agentRun 2435ms
```

Plugin loading (including the transpilation cache-hit import) takes only 83ms; Agent model interaction dominates, as expected.

---

## 5. Usage-effect verification (real command smoke test)

| Scenario | Result |
| --- | --- |
| `harness config set/list/get/rm` | ✓ normal, apiKey output masked to `sk-***890` |
| Running without a Key | ✓ outputs "✗ Missing API Key + hint: run harness login" |
| `harness run --json --timing` | ✓ structured JSON + five-stage timings |
| `harness run` (normal mode) | ✓ real-time progress: `▶ Step 1 → ↳ tool hello(...) → ✓ hello → ✓ step completed` |

---

## 6. Affected files list

| Module | File | Change |
| --- | --- | --- |
| kernel | `errors.ts` (new), `index.ts` | structured errors, masking |
| config | `loader.ts` | content-hash transpilation cache + concurrency lock |
| sandbox | `index.ts`, `package.json` | structured permission errors (PERMISSION) |
| session | `index.ts` | event-limit pruning option |
| cli | `cli.ts` (rewritten), `config-store.ts` (new), `output.ts` (new), `base-bundle.ts` | global command, login/config, progress, --json/--timing/--verbose, error hints, default safe level, scaffolding enhancements |
| root project | `package.json` | `bin`, `pnpm harness` script |
| scripts | `bench.mjs` (new) | performance benchmark |

## 7. Outstanding items completion status (new in this round)

The 4 previously outstanding items have all been landed and verified:

| Outstanding item | Status | Implementation and verification |
| --- | --- | --- |
| **token-level streaming output** | ✅ | llm `ChatProvider.stream()` (SSE parsing, supports `data: [DONE]`, incremental tool_calls accumulation, usage); agent `onToken` pass-through (automatically falls back to chat when streaming is unsupported); CLI `--stream` renders token by token. Verified with a real model (character-by-character scrolling output) |
| **`harness dev` hot reload** | ✅ | watches the content hash of the patch plugin entry file (500ms polling); on change it unmounts → remounts → automatically reruns the task; Ctrl-C to exit. Real demo: after modifying the plugin, the v2 tool copy takes effect automatically |
| **session persistence management** | ✅ | `FileSessionStore` (JSONL append, cross-process); `harness session ls/show/rm` (supports id-prefix matching); `run` writes to `~/.zhuxing-harness/sessions` by default (overridable with `--session-dir` / `HARNESS_SESSION_DIR`) |
| **shell completion** | ✅ | `harness completion [bash|zsh]` generates subcommand completion scripts |

**Design defect fixed during the process**: tool registration did not know about the plugin lifecycle → `ToolRegistry.register` returns an unregister function, and the plugin binds it with `ctx.effect` (examples and scaffolding template updated), leaving zero residue on hot reload/unmount. This is exactly the "side-effect cleanup" landing in the "hot-swap dedicated" section 8.1 of the Plan.

**Test increments**: llm SSE streaming (2), agent onToken (2), FileSessionStore (4), tools disposer (1) — 9 new items, **all 72 tests pass**.

## 8. Outstanding and future work

- `run --resume` (session resume, based on FileSessionStore and the AgentLoop session-recovery interface).
- Web UI (planned for phase 2, added as a plugin).

## 9. Code cleanliness and architecture review (pre-delivery check on 2026-08-20)

### 9.1 Code cleanliness ✅

| Check item | Result |
| --- | --- |
| Unused dependencies | removed the unused `@zhuxing/harness-kernel` dependencies in the `llm` and `session` packages (full scan of src imports cross-checked against package.json one by one) |
| Runtime artifacts | deleted the `plugins/` (install copies) and `.harness-cache/` transpilation cache, both added to `.gitignore` (including `dist/`, `node_modules/`) |
| Redundant copies | `plugins/hello-plugin.patch.yml` and `examples/hello-plugin.patch.yml` duplicated → keep one in examples, update doc references |
| Type cleanliness | `strict` + `noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch` enabled throughout, typecheck zero warnings |
| Test pollution | CLI tests use `HARNESS_CONFIG` / `HARNESS_SESSION_DIR` pointing to temp directories, not touching user config |

### 9.2 Architecture clarity ✅

| Check item | Result |
| --- | --- |
| Layering | `kernel` (kernel with no business logic) → `config/session/agent/tools/sandbox/llm` (capability plugins) → `sdk` (aggregated exports) → `cli` (composition entry), one-way dependencies, no cycles |
| Package responsibilities | each package has a single responsibility; `src/index.ts` barrel exports are complete and naming is consistent |
| No privileged core | all capabilities in the base bundle are plugins (sandbox/session/tools/llm/core-tools/agent), replaceable as a whole |
| Lifecycle | tool registration returns a disposer bound to `ctx.effect`, zero residue on hot reload/unmount |
| Known trade-off | `cli.ts` is a single ~780-line file organized by command function (main dispatch + one function per command); the package-level architecture is already clear, not splitting for now to avoid regression |

### 9.3 Tests ✅ (final status)

- **All 79 tests pass** (`pnpm -r test` + `pnpm test:e2e`), `pnpm typecheck` passes, `pnpm -r build` passes.
- This round added 7 CLI process-level smoke tests (help / validate / list / completion / config masking / session / error classification).
- Coverage: kernel (including hot-swap stress tests), config layering and transpilation cache, session (memory/file/pruning), model (non-streaming/SSE streaming), tool pipeline, sandbox policy, Agent loop (including streaming pass-through), SDK DSL, all CLI commands, end-to-end real path.
