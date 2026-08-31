# Zhuxing Harness — A Harness System with Free Plugin Integration · Plan

> Version: v0.1 (Draft)
> Date: 2026-08-20
> Tech stack: TypeScript
> Positioning: Drawing on the "everything is a plugin" design of DeepSeek Harness, to build from scratch an independent Agent Harness runtime with freely attachable plugins
> First-phase delivery form: **Plugin SDK + CLI**

---

## 1. Project background and goals

### 1.1 Background

DeepSeek open-sourced DeepSeek Harness (CLI name `dsh`) in 2026, whose core philosophy is "**Everything is a plugin**": model adapters, tools, sessions, sandbox, storage, the Agent loop, and the UI are all provided by plugins, driven at the bottom by the Cordis plugin framework, with no privileged core. This design effectively solves three pain points of traditional Agent frameworks:

1. **Heavy framework coupling**: model/tool/session are hard-coded in the core loop; extending requires modifying the framework itself.
2. **Difficult capability replacement**: switching models, sandbox, or storage requires forking or large amounts of adapter code.
3. **Weak composability**: multi-plugin collaboration, composing capabilities by config, runtime traceability, etc., are missing.

### 1.2 Goals

Build an **independent, pluggable Harness runtime** that achieves the following goals:

| # | Goal | Acceptance criteria |
| --- | --- | --- |
| G1 | Everything is a plugin | Models, tools, sessions, sandbox, storage, loop, and CLI output are all replaceable plugins, with no privileged core |
| G2 | Freely attachable plugins | Third-party plugins can be mounted via SDK + config without modifying the core source |
| G3 | Runtime traceability | Everything the model sees is recorded as an append-only session event log, supporting fork / resume / replay |
| G4 | Secure and controllable | Tool execution uniformly goes through the sandbox + permission policy pipeline |
| G5 | Developer friendly | Provide a type-safe plugin SDK, CLI, examples, and docs; plugins can be developed, published, and installed independently |

### 1.3 Non-goals (not promised in the first phase)

- No built-in Web UI (the first phase delivers CLI and SDK; UI will be added later as a plugin).
- No multi-tenant SaaS deployment.
- No pursuit of binary/API compatibility with dsh.

---

## 2. DeepSeek Harness research conclusions (key points)

> Data snapshot: official repository [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), MIT license, status Developer Preview; about 167k stars, 17.9k forks, 12.9k commits; latest version `0.1.0-rc.8`.

### 2.1 Core architecture facts

- **Plugin model**: a plugin is a TS module exporting an `apply(ctx)` function, also supporting object / class forms; capabilities are registered through `ctx`, cleanup via `ctx.effect()`, dependencies declared through `inject`.
- **Capability seams**: model `ctx.llm`, tools `ctx.tools`, commands `ctx.commands`, filesystem `ctx.fs`, sandbox `ctx.sandbox`, session/storage, Agent loop, scheduling, UI.
- **Composition**: `profile` (web / headless / custom) → `bundle` (dsh-base / dsh-web-app / dsh-headless) → `patch` (`cordis.yml` overlay), layered and applied in order; any line can be replaced with its own patch.
- **Session log iron rule**: **Model-visible means logged**. fork / resume / replay / telemetry all derive from the same event stream.
- **Execution model**: `step` = one model request + the tools it calls; `turn` = zero to many steps; `agent/*` and `tools/*` events are used for interception/rewrite/rejection.
- **Runtime modes**: Standard (full), Code (model generates code to orchestrate tools), Minimal (shell + editor only), Creator (runtime inspection + plugin experimentation).
- **Ecosystem plugins**: `dsh-agent-teams` (607 stars), `dsh-auto-mode` (111 stars), `context-vista`, `dsh-bottom-info-bar`, `dsh-specs`, etc., all distributed via the `dsh-plugin` topic.

### 2.2 What to borrow and what to discard

| Design point | Borrow | Discard/own build |
| --- | --- | --- |
| Plugin form (apply/inject/effect) | ✅ adopt the same mental model | define the SDK types and conventions ourselves |
| No privileged core | ✅ adopt | the kernel provides only minimal context + lifecycle |
| Session event log iron rule | ✅ adopt | custom event schema |
| profile/bundle/patch layering | ✅ adopt | simplify naming, focus on the CLI scenario |
| Cordis dependency | ❌ not introduced | a lightweight self-built dependency-injection + event + lifecycle kernel |
| Web UI / Python SDK | ❌ not in the first phase | as later plugins |

---

## 3. Overall architecture design

### 3.1 Architecture principles

1. **No privileged core**: the kernel is only responsible for "context, lifecycle, dependency injection, events, service registration" — it contains no Agent business logic.
2. **Capability as plugin**: models, tools, sessions, sandbox, storage, loop, commands, and CLI output are all plugins.
3. **Config composition rather than code modification**: select/replace/extend capabilities through YAML patches, without modifying the core source.
4. **Reversible side effects**: everything registered via `ctx` is automatically cleaned up when the plugin unmounts.
5. **Model-visible = recorded**: all inputs that enter a model request must be reconstructible from the session log.

### 3.2 Layered structure

```
┌─────────────────────────────────────────────────────┐
│  CLI (entry: profile / bundle / patch loading, command dispatch)   │
├─────────────────────────────────────────────────────┤
│  Built-in Bundle (base: model/tool/session/sandbox/storage/loop)      │
├─────────────────────────────────────────────────────┤
│  Plugin SDK (types, DSL, validation, config parsing, publishing tools)          │
├─────────────────────────────────────────────────────┤
│  Kernel (core: Context, Lifecycle, DI, Event, Service) │
└─────────────────────────────────────────────────────┘
```

### 3.3 Core concepts

| Concept | Description |
| --- | --- |
| **Context (ctx)** | the only entry point for plugins to interact with the kernel, carrying capability registration, dependency access, event subscription, and cleanup registration |
| **Plugin** | a mountable capability unit, in three forms: function (`apply(ctx)`), object, class (provides a Service) |
| **Service** | a named capability a plugin exposes for other plugins to inject via `inject` |
| **Event** | a typed event bus for loosely-coupled collaboration and interception between capabilities |
| **inject** | the dependency list a plugin declares; the kernel guarantees `apply` runs only after dependencies are ready |
| **effect** | reversible side-effect registration; cleanup runs automatically when the plugin unmounts |
| **Profile / Bundle / Patch** | layered descriptions of a runtime composition: a Bundle is a patchable plugin layer, a Patch is overlay config |

---

## 4. Plugin SDK design (core deliverable)

### 4.1 Minimal plugin form

```ts
import type { Context } from '@zhuxing/harness-sdk'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  ctx.logger.info('[hello-plugin] loaded')

  // Register a tool (capability)
  ctx.tools.register({
    name: 'hello',
    description: 'Say hello',
    schema: { type: 'object', properties: {} },
    execute: async () => ({ text: 'hello' }),
  })

  // Register a reversible side effect (cleaned up automatically on unmount)
  ctx.effect(() => {
    const timer = setInterval(() => {}, 5000)
    return () => clearInterval(timer)
  })
}
```

### 4.2 Dependency injection and lifecycle

```ts
import type { Context } from '@zhuxing/harness-sdk'

export const name = 'my-tool-plugin'
export const inject = ['tools', 'sandbox']  // dependency declaration; the kernel guarantees readiness

export function apply(ctx: Context) {
  // Here ctx.tools / ctx.sandbox are already available
  ctx.tools.register(/* ... */)
}
```

Lifecycle order: `resolve config → resolve dependencies → apply(register capabilities) → run → dispose(cleanup)`. The kernel maintains the plugin dependency topology and detects circular dependencies, reporting an error.

### 4.3 Capability seams

Each capability consists of three roles, "interface declaration (Service Definition) → implementation (Provider) → consumer (Consumer)", which can evolve independently.

| Seam | Injection key | Provided in phase 1 | Description |
| --- | --- | --- | --- |
| Model adapter | `llm` | ✅ | unified chat/completion interface, supports multi-model routing |
| Tool registry | `tools` | ✅ | tool schema merged into prompt assembly, unified execution pipeline |
| Commands | `commands` | ✅ | human-entered commands, do not trigger a model turn |
| Session/storage | `session` / `storage` | ✅ | append-only event log + pluggable persistence backend |
| Agent loop | `loop` | ✅ | turn/step orchestration, `agent/*` event interception |
| Sandbox | `sandbox` | ✅ | process/filesystem isolation + tiered permission policy |
| Filesystem | `fs` | ✅ | replaceable FS abstraction, supports virtual/remote |
| Scheduler | `scheduler` | ⏳ | background tasks/scheduled execution (phase 2) |
| UI/output | `ui` | ⏳ | terminal rendering, later extended to Web UI (phase 2) |

### 4.4 Event system

- Typed events: `agent/pre-step`, `agent/post-step`, `tools/before-exec`, `tools/after-exec`, `session/event`, etc.
- Listeners can rewrite or reject, used for policy interception, approval, telemetry, and auditing.
- The phase-1 event list is frozen at M1.

### 4.5 Plugin config and validation

- A plugin declares a schema via `config`, validated at runtime and injected into `ctx.config`.
- `harness validate <plugin>` validates the plugin structure, dependencies, and schema legality.
- `harness create-plugin` scaffolding generates plugin templates.

---

## 5. Core module split

| Module | Responsibility | Phase-1 scope |
| --- | --- | --- |
| `kernel` | Context, lifecycle, dependency injection, event bus, Service registration | complete |
| `config` | profile/bundle/patch layered parsing and merging, config validation | complete |
| `session` | append-only event log, fork / resume / replay, telemetry | complete |
| `agent` | turn/step orchestration, prompt assembly, sub-agents (spawn/fork) | core paths |
| `tools` | tool registry, execution pipeline (intercept→sandbox→approve→timeout retry→result normalization) | core paths |
| `llm` | model adapter interface, OpenAI-compatible endpoints, multi-model routing | core paths |
| `sandbox` | tiered permission policy (workspace-write / read-only / danger-full-access) | core paths |
| `cli` | command entry, `harness web`/`run`/`validate`/`create-plugin` | core paths |
| `sdk` | plugin types, DSL, config parsing, publishing tools | complete |

---

## 6. Directory structure (planned)

```
zhuxing-harness/
├── packages/
│   ├── kernel/            # kernel: Context, Lifecycle, DI, Event, Service
│   ├── sdk/               # plugin SDK: types, DSL, validation, scaffolding
│   ├── config/            # profile/bundle/patch parsing and merging
│   ├── session/           # session event log, fork/resume/replay
│   ├── agent/             # turn/step loop, sub-agents
│   ├── tools/             # tool registry and execution pipeline
│   ├── llm/               # model adaptation and routing
│   ├── sandbox/           # sandbox and permission policy
│   └── cli/               # CLI entry and commands
├── examples/
│   └── hello-plugin/      # minimal plugin example
├── docs/                  # architecture, SDK guide, plugin development guide
├── cordis.yml             # default composition config
└── package.json           # pnpm workspace
```

---

## 7. Phased milestones (Roadmap)

| Phase | Goal | Key deliverables |
| --- | --- | --- |
| **M0 spec freeze** | freeze kernel API, event list, session event schema, plugin spec | spec docs, ADR |
| **M1 kernel + config** | self-built lightweight kernel (Context/Lifecycle/DI/Event/Service) + layered config loading | kernel can load a minimal plugin and run apply/dispose |
| **M2 session + loop** | append-only session log + turn/step orchestration + `agent/*` events | can run one empty loop and write the log |
| **M3 tools + sandbox** | tool registry, execution pipeline, tiered permission policy | tools can execute safely and be replayed |
| **M4 model adaptation** | `ctx.llm` interface, OpenAI-compatible endpoints, multi-model routing | close the "model→tool→result" loop |
| **M5 SDK + CLI** | plugin SDK, `create-plugin`/`validate`/`run` commands, example plugin | third-party plugins can be mounted and run |
| **M6 ecosystem and docs** | plugin publish/install, docs, acceptance tests | satisfy all G1–G5 acceptance criteria |

---

## 8. Risks and responses

| Risk | Impact | Response |
| --- | --- | --- |
| Over-engineered self-built kernel | complexity out of control | in phase 1 only implement the minimal usable capability; add features incrementally by seam, no speculative abstractions |
| Early plugin API instability | ecosystem migration cost | freeze the spec at M0, adopt semantic versioning and a compatibility layer strategy |
| Insufficient sandbox security boundary | high-risk operations leak | reference dsh's permission tiers, read-only by default, writes/dangerous operations require approval |
| Divergence from the upstream dsh community | reuse cost | borrow interface mental models, keep terminology consistent, provide dsh plugin migration guidance when necessary |
| Defective session log schema design | replay/fork fails | follow the "model-visible = recorded" iron rule, freeze the schema at M0 and run replay tests |
| Plugin hot-swap | dangling references/state loss/resource leaks | see the dedicated design in 8.1 below; make hot-swap a first-class kernel capability rather than an afterthought |

---

### 8.1 Plugin hot-swap (dedicated focus)

> Conclusion: hot-swap is the "necessary risk" of this system, and also the value of pluginization — problems are inevitable, so it is designed in advance as a first-class kernel capability rather than patched in after release.

Hot-swap scenarios include runtime **mount / unmount / reload**, and **hot updates (HMR)** of config patches.

#### Main difficulties

1. **Cascading unmount of the dependency topology**: when a depended-upon Service unmounts, its consumers lose the dependency and must be cascaded down or downgraded to a fallback implementation, otherwise dangling references result.
2. **In-flight operations**: async tools, sub-agents, and timers still executing at the instant of unmount need safe termination or to wait for completion.
3. **State migration and loss**: in-memory state (session intermediate state, caches, connection pools) is lost on unmount; it must be clarified what must be persisted and what may be lost.
4. **Side-effect cleanup ordering**: `dispose` must be idempotent and ordered (children before parents, consumers before providers).
5. **Event listener races**: events still dispatched after the unmount flag cause use-after-dispose.
6. **Duplicate mount / version conflicts**: different versions of the same plugin coexisting, duplicate id conflicts.
7. **Circular dependencies**: more easily triggered under the dynamic hot-swap topology.

#### Response strategies

- **Lifecycle contract**: unified `mount → apply → dispose → unmount`, `dispose` idempotent, fixed unmount order.
- **Reverse dependency graph**: the kernel maintains a reverse dependency graph and automatically cascades consumers on unmount, or downgrades to a declared fallback implementation.
- **In-flight task tracking**: `ctx` uniformly registers in-flight handles, prioritizing cancellation on unmount and, when necessary, waiting with a timeout.
- **State boundary**: state that crosses sessions/needs reuse must go through `storage`; pure in-memory state is allowed to be lost by default and is documented as such.
- **Event serialization**: after the unmount flag takes effect, stop dispatching events to that plugin; `dispose` and the event loop run serially.
- **Unique id + version**: a plugin must have a unique id and version; duplicate ids are rejected on mount, and an upgrade of the same id goes through "unmount old → mount new".
- **Stress testing**: every kernel version runs a "random mount/unmount" stress test to guarantee no resource leaks, no dangling references, and no uncleaned `effect`s.

---

## 9. Quality and acceptance constraints

1. **Observable**: all critical paths output structured logs, and the session event stream can be replayed.
2. **Testable**: the kernel, tool pipeline, sandbox policy, and config merging all have unit tests; the closed loop has integration tests.
3. **Type-safe**: the SDK is in strict TypeScript mode throughout, and plugin integration is checked at compile time.
4. **Minimal core**: the kernel contains no Agent business logic; new capabilities always go through plugins, never intruding into the core.
5. **Docs in sync**: each milestone must update the architecture and plugin development guide in `docs/` accordingly.

---

## 10. Next actions

1. Freeze the **M0 spec**: kernel API, event list, session event schema, plugin spec (ADR).
2. Set up the pnpm workspace and the two package skeletons `kernel` / `sdk`.
3. Implement the `hello-plugin` example to close the minimal "load → apply → dispose" loop.
4. Progress through M1 → M6 phase by phase.

---

## 11. Development progress (updated 2026-08-20)

> Milestones M0–M5 have all been landed, and the real-model closed loop has been verified (DeepSeek v4-flash).

| Milestone | Status | Deliverable |
| --- | --- | --- |
| M0 spec freeze | ✅ implementation is the spec | kernel API / event list / session schema have been landed in code |
| M1 kernel + config | ✅ | `kernel` (Context/Lifecycle/DI/Event/Service + hot-swap), `config` (layered parsing + TS transpile loading) |
| M2 session + loop | ✅ | `session` (append-only log, fork/replay), `agent` (turn/step, agent/* interception) |
| M3 tools + sandbox | ✅ | `tools` (registry + execution pipeline), `sandbox` (three-tier permission policy) |
| M4 model adaptation | ✅ | `llm` (unified interface + OpenAI-compatible endpoints, default DeepSeek) |
| M5 SDK + CLI | ✅ | `sdk` (aggregated exports + defineTool), `cli` (run/validate/create-plugin/install/list) |
| M6 ecosystem and docs | ⏳ partial | plugin install (install copies to plugins/, gitignored, as a local artifact); publishing to npm / docs site pending |

### Hot-swap dedicated landing status (Plan 8.1)

- Lifecycle contract: `mount → apply → dispose → unmount`, dispose idempotent ✅
- Reverse dependency graph + cascading unmount (consumers before providers) ✅
- Circular dependency detection (supports `provides` declaration) ✅
- in-flight tracking (unmount waits with timeout) ✅
- Configurable dependency-wait timeout (`mount({ timeoutMs })`, reload defaults to 5s) ✅
- Event serialization: stop dispatching events to the plugin after unmount ✅
- Unique id + version conflict detection ✅
- **Stress test**: 60 rounds of random mount/unmount/reload with no leaks + 30 repeated unmounts of the same plugin stable ✅

### Verification records

- Unit tests + e2e: **all 49 tests pass**, typecheck passes
- Real-model closed loop (`harness run -p examples/hello-plugin.patch.yml`):
  the model called in parallel the external plugin tool `hello` + the built-in tool `list_dir`, results returned correctly,
  the session trace fully replayed (user → assistant → tool×2 → assistant), and the plugin unmounted cleanly.
- Known fixes: patch relative paths resolved relative to the config location; CLI default endpoint changed to DeepSeek; consumers consuming their own service are not registered (preventing cascading infinite loops); pending timeout cancellation unref.

---

## 12. Commercialization roadmap (2026-08-20)

> Goal: move from "developer preview" to "a commercially qualified product". Iterate continuously until it qualifies, then deliver.

### 12.1 Commercial qualification criteria (acceptance checklist)

| Dimension | Criteria |
| --- | --- |
| Distribution | installable via `npm i -g` / `npx`; a single-file binary provided (no Node environment required) |
| Versioning | semantic versioning + CHANGELOG; git version control with traceable commits |
| Docs | root README (install/quick start) + docs/ (CLI reference, configuration, plugin development, security model) |
| Quality | CI gates (build/typecheck/test/e2e); exit-code conventions; `harness doctor` environment self-check |
| Robustness | clean exit with signal handling; Windows/Linux/macOS compatibility; self-serviceable error messages |
| Security | credential persistence + output masking + safe-by-default sandbox; license (MIT) |
| Support | observable logs; diagnostic commands; clear support boundaries |

### 12.2 Implementation milestones

| Milestone | Content | Status |
| --- | --- | --- |
| P0 engineering foundation | git init (root-commit `b6ec9b6`), README, LICENSE(MIT), CHANGELOG, exit-code conventions (0/1/2), version/doctor, pnpm check gates | ✅ done |
| P1 distribution and CI | GitHub Actions gates (ubuntu+windows × node 20/22), esbuild single-file binary (`dist-bin/harness.cjs`, 349KB runs standalone) | ✅ done |
| P2 user docs | docs/ quick start, CLI reference, configuration, plugin development guide, security model | ✅ done (quickstart / cli / configuration / plugins / security) |
| P3 commercial validation | release automation (`scripts/publish.mjs` topological order + publishConfig public + aggregated package `@zhuxing/harness` one-command install); all 10 packages pass dry-run; cross-platform smoke / official release requires npm account and remote | release script ready, official release pending npm authorization |
