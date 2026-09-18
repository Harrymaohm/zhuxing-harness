# Zhuxing Harness

> **Plugin-first kernel · Open tool ecosystem · Signed & governed · Self-growing knowledge**
> A from-scratch, open-source Agent runtime whose kernel holds zero business logic — every capability, including the tool ecosystem itself, mounts as a plugin.

[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Source--Available%20%2F%20Commercial-9c27b0.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-0078d4.svg)](#install)
![Status](https://img.shields.io/badge/status-Active%20Development-brightgreen.svg)

> 中文版请见 [README.zh-CN.md](README.zh-CN.md) · For the Chinese version, see [README.zh-CN.md](README.zh-CN.md).

---

## Table of Contents

- [In One Sentence](#in-one-sentence)
- [Why It Is Built This Way](#why-it-is-built-this-way)
- [Core Capabilities](#core-capabilities)
  - [1. Plugin-First Kernel: The Kernel Does No Business Logic](#1-plugin-first-kernel-the-kernel-does-no-business-logic)
  - [2. Open Tool Ecosystem: a Built-in MCP Client](#2-open-tool-ecosystem-a-built-in-mcp-client)
  - [3. Trust: Permission Manifest & ed25519 Signature](#3-trust-permission-manifest--ed25519-signature)
  - [4. Three-Tier Permission Sandbox](#4-three-tier-permission-sandbox)
  - [5. Model-Agnostic, with Multi-Sub-Model Routing](#5-model-agnostic-with-multi-sub-model-routing)
  - [6. Experience That Compounds: Memory · Knowledge · Skills](#6-experience-that-compounds-memory--knowledge--skills)
  - [7. Delivery: From Answers to Artifacts](#7-delivery-from-answers-to-artifacts)
  - [8. Observability: OpenTelemetry GenAI Telemetry](#8-observability-opentelemetry-genai-telemetry)
- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
  - [Install](#install)
  - [Configure a model](#configure-a-model)
  - [Connect an MCP server](#connect-an-mcp-server)
  - [Run the Web UI](#run-the-web-ui)
- [Writing a Plugin](#writing-a-plugin)
- [A Complete End-to-End Example](#a-complete-end-to-end-example)
- [Differences From Comparable Projects](#differences-from-comparable-projects)
- [Use Cases (Multi-Industry)](#use-cases-multi-industry)
- [Command Reference](#command-reference)
- [Documentation](#documentation)
- [License](#license)

---

## In One Sentence

**Zhuxing Harness is not "another Chinese version of Claude Code", nor a set of prompt templates.**

It is an Agent runtime built on a single rule: **plugins are the only primitive.**

- **Zero-privilege kernel** — `kernel` provides only `Context`, lifecycle, dependency injection and an event bus. It contains no agent business logic at all;
- **Everything is replaceable** — models, tools, sessions, sandbox, memory, knowledge, skills, the agent loop and CLI output are all plugins; any layer can be swapped or extended through `profile` / `patch` configuration, without touching the kernel;
- **Open ecosystem** — a built-in MCP client (stdio transport, dual-era protocol negotiation) lets the agent use the wider MCP tool ecosystem without writing a line of plugin code;
- **Governed rather than merely trusted** — plugins may declare the permissions they need, and plugin directories can be ed25519-signed; when a keyring is configured, verification is fail-closed;
- **It compounds** — documents become searchable, traceable knowledge; proven workflows become reusable skills; cross-session experience becomes memory.

> If a traditional agent framework is "handing the AI a toolbox", the goal of Zhuxing Harness is: **let the AI grow its own toolbox bigger and more convenient through use.**

---

## Why It Is Built This Way

| Industry pain point | Zhuxing's answer |
|----------|-----------|
| Agent frameworks hard-code business logic into the kernel, making them hard to customize | Privilege-free kernel; capability = plugin; layered `profile` / `patch` config swaps or extends any layer |
| Tool ecosystems are closed — every new integration needs bespoke code | Built-in **MCP client**: point it at any stdio MCP server and its tools become available to the agent |
| Installing third-party plugins means handing over the machine with no review path | Plugins declare a **permission manifest**, and can be **ed25519-signed**; a configured keyring makes verification fail-closed |
| Mainstream agents are deeply tied to overseas models & accounts, hard for Chinese enterprises to adopt | Fully pluggable models — bring your own Key / BaseURL, compatible with any OpenAI-protocol endpoint (Bailian, Qwen, DeepSeek, etc.) |
| Permission runaway and no audit trail, so enterprises won't adopt | `read-only` / `workspace-write` / `danger-full-access` three-tier isolation; every tool call is recorded in the session event log |
| Knowledge bases are just "document Q&A", discarded after use | Self-growing knowledge base + semantic retrieval + source traceability |
| Agents re-reason from scratch every time, getting more exhausted | Workflows deposited as Skills, experiences as Memory — reusable next time |
| You cannot tell what the agent actually did or how much it cost | **OTel GenAI** spans for every LLM call (opt-in), plus `agent/llm-*` events on the bus |

---

## Core Capabilities

### 1. Plugin-First Kernel: The Kernel Does No Business Logic

Zhuxing's most fundamental design principle: **plugins are the only primitive, and the kernel is zero-privilege.**

The entire `Context` surface a plugin can use is:

| API | Semantics |
|-----|-----------|
| `provide(name, impl)` | Register (or override) a service |
| `inject(name)` | Resolve a service; throws if absent |
| `injectOptional(name)` | Resolve a service, or `undefined` |
| `effect(disposer)` | Register a reversible side-effect, run in reverse order on unload |
| `on` / `once` / `emit` | Subscribe / subscribe once / dispatch events; listeners are removed automatically on unload |
| `track(promise)` | Track in-flight work so unload can wait for it |

On top of that, the plugin manager handles the hard parts: plugins whose dependencies are not ready yet are parked as *pending*, unloading a plugin **cascades** to its consumers, **circular dependencies are detected**, and `dispose` runs effects in reverse order before waiting on in-flight tasks.

In practice this means **19 packages** interlock purely through services and events — there is no privileged "core" that plugins cannot replace. The shipped runtime wires **15 plugins** across 11 domain files, each declaring what it injects and what it provides.

### 2. Open Tool Ecosystem: a Built-in MCP Client

Rather than asking you to hand-write a plugin for every integration, Zhuxing speaks **MCP (Model Context Protocol)** — so any MCP server's tools become the agent's tools.

**Transport and protocol — the honest details:**

- **stdio only.** HTTP / SSE MCP servers are explicitly detected, warned about and skipped — they are not silently ignored;
- **Dual-era negotiation.** The client first sends `server/discover`. If the server understands it, it is treated as **modern (`2026-07-28`)**: the modern protocol is stateless, has **no `initialize` handshake**, and carries version + capabilities inline in each request's `_meta`. Otherwise the client falls back to the **legacy (`2025-06-18`) `initialize`** handshake followed by `notifications/initialized`;
- **Reserved errors are not a fallback signal.** If the server returns an error from the protocol's reserved range (`-32020`…`-32099`), the client does **not** fall back — that range means the server is modern, and `-32022` means "unsupported version", so the client disconnects rather than guessing.

**What is exposed:** tools, and only tools. This client implements `tools/list` and `tools/call`; `resources/*`, `prompts/*`, `sampling`, `roots` and `elicitation` are **not** implemented, and the client honestly advertises empty capabilities. Server-initiated requests are refused rather than half-answered.

**Naming and safety:** MCP tools are registered as `mcp__<server>__<tool>` (a server name may not contain `__`, to keep the mapping unambiguous), and results are truncated at 64 KB by default so a chatty server cannot blow up the context window.

**Configuration:** declare servers under `mcpServers` in `~/.zhuxing-harness/config.json`. If `mcpServers` is absent, the MCP plugin is not registered at all — zero behaviour change for existing setups. Per-server options include `args`, `env`, `cwd`, `disabled`, and timeouts for init / list / call.

### 3. Trust: Permission Manifest & ed25519 Signature

Opening the tool ecosystem only makes sense if you can govern what you install. Zhuxing provides two mechanisms — and is explicit about what each one does and does not do.

**Permission manifest (governance).** A plugin can declare `fsRead` / `fsWrite` / `shell` / `net` / `env`. The manifest is enforced **at the tool-execution boundary**: inside `ToolRegistry.execute`, plugin permissions are checked before the sandbox adjudicates, and a violation returns a readable error while leaving a `tools/after-exec` record tagged `rejectedBy: 'plugin-permissions'` with the offending plugin id.

To be precise about the boundary: this is **governance, not isolation**. `fsRead` / `fsWrite` / `shell` are checked on the tool path; `net` and `env` are currently declaration-only, with no enforcement point. A hostile plugin running as a Node module can still bypass the manifest entirely by importing `node:fs` directly. The manifest exists to make a plugin's intentions explicit and auditable — not to sandbox arbitrary code.

**ed25519 directory signature (a real boundary).** A plugin directory can be signed: each file is hashed, the per-file digests are combined into a manifest which is hashed again, and that directory digest is signed with ed25519. `node_modules`, `.git`, `dist`, `.harness-cache` and the signature file itself are excluded, as are `.map` and `*.tsbuildinfo` — otherwise a rebuild would be misreported as tampering.

Verification is **fail-closed** once you configure a keyring (via `HARNESS_PLUGIN_KEYRING` or `plugins.trustedKeys` in config): a plugin that is unsigned, signed by an unknown key, malformed, or whose contents no longer match its signature is **refused at load**. With no keyring configured, plugins still load but you get an explicit "not verified" notice.

Three commands make this usable day to day: `harness plugin-keygen`, `harness plugin-sign`, and `harness plugin-verify`.

### 4. Three-Tier Permission Sandbox

| Tier | Capability | Typical operations |
|------|------|---------|
| **`read-only`** | Observe only, zero side-effects | Read files, list directories, search knowledge |
| **`workspace-write`** (default) | Restricted execution, writes only inside the workspace | Generate files, run scripts, write artifacts |
| **`danger-full-access`** | Complete local control | Arbitrary commands, outbound access (requires explicit authorization) |

Design points:

- Every command and every write is adjudicated by `Sandbox.checkCommand` / `checkWrite`. Command adjudication is ordered: explicit `deniedCommands` first, then `danger-full-access` short-circuits, then the `allowedCommands` allow-list, and finally the write-intent blacklist;
- The blacklist covers destructive filesystem verbs (`rm` / `mv` / `cp` / `mkdir` / `remove-item` / `set-content` …), output redirection, in-place `sed -i`, interactive editors, permission changes (`chmod` / `icacls` …), VCS mutations (`git push` / `commit` / `reset` / `clean` …), package-manager installs and publishes, and `curl -o` / `wget` / `dd` / `mkfs`. Shell wrappers (`sh -c`, `cmd /c`, `powershell -c`, `env`) are unwrapped up to three levels so the inner command is judged, not the wrapper;
- **Credential files are unreadable at every tier.** `checkRead` refuses `.env`, `secrets.*`, `id_rsa` and friends, `.git-credentials`, `.netrc` and `credentials.*` regardless of permission level;
- Tools declare which argument must be guarded via `sandbox: { commandArg, writeArg }`;
- `workspace-write` boundaries are resolved with path normalisation, symlink `realpath` and separator-aware comparison — not naive string prefix matching;
- The agent cannot raise its own permissions, nor modify the permission layer itself.

### 5. Model-Agnostic, with Multi-Sub-Model Routing

**Models are plugins, not the foundation.**

- You supply your own **API Key** and **API Base URL** — no vendor is forced on you;
- A unified `OpenAICompatibleProvider` is built on the OpenAI-compatible protocol, with built-in support for Bailian / Qwen, DeepSeek and other endpoints;
- The `Provider` abstraction is clean — integrating a new vendor only requires implementing a `ChatProvider`;
- The agent loop, skills, knowledge base and permission system are completely unaware of the concrete model.

> You can run the whole agent on domestic models in an air-gapped environment with no access to OpenAI or Anthropic. This is "model sovereignty" landed in code, not a slogan.

When one model is not enough, the bundled `model-router` plugin adds governance on top:

- **Registry** — hot-pluggable register / unregister of sub-models;
- **Monitoring** — sliding-window metrics per model (latency, success rate, tokens, cost);
- **Selector** — scores candidates by intent-keyword hits, context length and live performance to pick the best fit;
- **Routing with fallback** — automatic failover to a backup model behind a unified output format;
- **Orchestration** — the orchestrator model delegates subtasks to sub-models through the `pick_model` / `list_models` tools.

### 6. Experience That Compounds: Memory · Knowledge · Skills

**Knowledge base** — from Q&A to a traceable corpus:

- Uploaded documents are automatically **chunked** (paragraph-aware, default 800 chars, 120 overlap); plain text / docx / pptx / xlsx are supported;
- Configure Embedding (OpenAI-compatible `/embeddings`) to enable **semantic retrieval (RAG)**; when unconfigured it degrades gracefully to keyword matching (CJK bigrams + Latin tokens);
- **Multiple spaces / directory trees / scopes**, with re-indexing;
- Retrieved content is injected into each dialog's system prompt (8 KB cap by default, to prevent context poisoning);
- Q&A is **traceable**: hits are annotated with their source and can be traced back to the original entry.

**Skills** — externalise "how to do it" into readable, manageable, versionable files:

- A skill = prompt template (`{{param}}` placeholders) + input JSON Schema + optional tool subset + memory binding;
- Stored as YAML — explainable, auditable, exportable, importable — and, since 0.4.0, compatible with the Agent Skills `SKILL.md` convention (`<skill-name>/SKILL.md` with YAML front matter), including upload of `.md` files or a `SKILL.md` inside a zip;
- Supports retrieval-based invocation and experience-based reuse; skills compose and parallelise;
- CLI: `harness skill list/add/rm/show/run/create`, plus the `use_skill` / `list_skills` tools.

**Memory** — accumulate "cross-session experience":

- Scopes: `user` / `project` / `auto` / `session`;
- Cross-session memory and session-private memory are auto-injected before each agent run (4 KB cap by default).

> This gives the agent **long-term memory + muscle memory**: instead of endlessly stretching context, experience is externalised to disk and reloaded when needed.

### 7. Delivery: From Answers to Artifacts

Zhuxing doesn't just "give you text in a dialog" — it **walks a real workflow and delivers files**:

- Read / search local files and project state (`read_file` / `list_dir`);
- Invoke generation scripts and run builds (`shell`, adjudicated by the sandbox);
- Generate **image / video / speech (TTS) / code / scripts** as real artifacts (`generate_image` / `generate_video` / `text_to_speech`);
- Write artifacts to a target directory and report full paths and re-run commands.

### 8. Observability: OpenTelemetry GenAI Telemetry

You should be able to see what the agent actually did — without paying for it when you don't care.

- **Off by default.** The `harness-telemetry` plugin returns immediately when no endpoint is configured: no listeners registered, no timers started, zero network traffic;
- **Standards-based export.** When you set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`, which gets `/v1/traces` appended), spans are batched and exported as **OTLP/JSON over HTTP** — no vendor SDK, no telemetry dependency. Service name comes from `OTEL_SERVICE_NAME`;
- **GenAI semantic conventions.** Spans follow the OpenTelemetry GenAI conventions (note: that specification is still in *Development* status, and Zhuxing tracks it as such);
- **Content capture is opt-in and masked.** `OTEL_GENAI_CAPTURE_CONTENT` controls whether prompts and responses are included, and when enabled the content passes through credential redaction first;
- **Kernel events for everything below the spans.** The agent loop emits `agent/llm-request` (`sessionId`, `step`, `model?`), `agent/llm-response` (adds `responseModel?`, `usage?`, `finishReasons`, `latencyMs`) and `agent/llm-error` (adds `errorType`, `message`, `latencyMs`), so you can build your own dashboards from the event bus instead of adopting OTLP.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                      Zhuxing Harness Runtime                    │
├────────────────────────────────────────────────────────────────┤
│  CLI / Web UI / Desktop        (entry · chat · deliverables)    │
│         │                                                       │
│         ▼                                                       │
│  Plugin Manager     provide · inject · effect · mount/unmount   │
│         │           pending deps · cascading unload · cycle det. │
│         ▼                                                       │
│  Agent Main Loop               turn/step orchestration          │
│         │                                                       │
│  Enhancement Chain         memory → session ctx → KB RAG → skill │
│         │                                                       │
│  Tool Pipeline     before-exec → plugin manifest → sandbox → …  │
│         │                    → retry → after-exec                │
│         ▼                                                       │
│  Tool Sources          built-ins · your plugins · MCP servers    │
│         │                                                       │
│  Model Layer            OpenAI-compatible Provider (routable)    │
│         │                                                       │
│  Local Environment         filesystem · workspace · scripts      │
│                                                                 │
│  Cross-cutting:  permission sandbox · plugin signing · OTel      │
└────────────────────────────────────────────────────────────────┘
```

Key design principles:

1. **Privilege-free kernel** — Context / lifecycle / DI / events, no business logic;
2. **Capability = plugin** — models, tools, sessions, sandbox, memory, knowledge, skills, loop, all replaceable;
3. **The tool ecosystem is open but governed** — MCP for reach, manifests and signatures for control;
4. **Permission is a cross-cutting concern** threaded through every tool call;
5. **Knowledge / skills / memory are externalised experience** — versionable, exportable, shareable.

---

## Quick Start

### Install

From source:

```bash
pnpm install
pnpm build
node packages/cli/dist/cli.js doctor      # environment self-check
```

A Windows NSIS installer is produced by `node scripts/build-nsis.mjs` (no admin required, installs to `%LOCALAPPDATA%\ZhuxingHarness`, bundles a portable Node runtime, start-menu shortcut and uninstaller).

**Release policy — stable versions only.** GitHub Releases carry stable builds only. Intermediate development builds are never announced as a release and are not offered as an installation package.

### Configure a model

```bash
harness login                              # one-time, interactive: API Key + Base URL
harness run "Summarize the structure of the current directory"
```

Any OpenAI-compatible endpoint works — Bailian / Qwen, DeepSeek, a local gateway, or anything you run yourself.

### Connect an MCP server

Add servers under `mcpServers` in `~/.zhuxing-harness/config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/expose"]
    }
  }
}
```

Every tool the server advertises is registered as `mcp__filesystem__<tool>` and becomes callable by the agent immediately. `harness doctor` reports each configured server's negotiated protocol era and tool count. If you remove `mcpServers` entirely, the MCP plugin is not mounted at all.

### Run the Web UI

```bash
harness web                                # default http://127.0.0.1:3080
```

> It is recommended to start at the `read-only` or `workspace-write` tier and open up permissions as you get familiar.

---

## Writing a Plugin

A plugin is a module that receives a `Context`. There is no base class to extend and no registration boilerplate — declare what you need, provide what you offer, and register whatever side-effects must be unwound:

```ts
export default {
  name: 'my-plugin',
  inject: ['tools'],
  provides: ['myService'],
  apply(ctx) {
    ctx.provide('myService', myServiceImpl)
    ctx.inject('tools').register(myTool)
    ctx.effect(() => myTool.dispose())      // runs on unload, reverse order
  },
}
```

Then compose it into your runtime through `profile` / `patch` configuration instead of editing code:

```bash
harness list                               # show the plugins resolved from config
harness run -p examples/hello-plugin.patch.yml "Use the hello tool to greet"
harness validate my-plugin/                # validate a plugin definition
```

If you are wiring this up for other people to install, sign the directory first:

```bash
harness plugin-keygen --out ./keys
harness plugin-sign ./my-plugin --key ./keys/private.pem
harness plugin-verify ./my-plugin --keyring ./trusted.json
```

---

## A Complete End-to-End Example

This chain shows Zhuxing Harness's "**learn → do → record → grow**" loop:

**① Assign the task**
> "Generate the 0.4.0 user manual and validate version consistency."

**② Execute autonomously**
- Read project files and historical sessions;
- Locate the generation script `scripts/gen-user-manual.cjs`;
- Run it through the sandbox to produce `.docx` and `.pdf`;
- Auto-validate version number, title, page count and path consistency.

**③ Deliver artifacts**
```
dist/ZhuxingHarness-user-manual-0.4.0.docx
dist/ZhuxingHarness-user-manual-0.4.0.pdf
```

**④ Deposit knowledge**
- Write the specs, workflow and validation points into the knowledge base, with traceability;
- Later Q&A can trace back to this artifact and its clauses.

**⑤ Deposit skill**
- Freeze the "release → manual → consistency check" workflow as a Skill;
- Next release reuses it directly, without re-reasoning.

> This is the minimal unit of "**growing with the user**": use once, learn once, deposit once, and be stronger next time.

---

## Differences From Comparable Projects

| Dimension | Traditional agent frameworks | Claude Code-style tools | **Zhuxing Harness** |
|------|------------------|--------------------|-------------------|
| Kernel role | Often hard-codes business logic | Bound to one vendor | **Privilege-free kernel, capabilities as plugins** |
| Tool ecosystem | Closed; integration needs bespoke code | Closed | **Built-in MCP client — any stdio MCP server works** |
| Plugin trust | Little to none | Limited | **Permission manifest + ed25519 signing (fail-closed with a keyring)** |
| Model binding | Often single-vendor | Single ecosystem | **Fully pluggable, OpenAI-compatible** |
| Domestic ecosystem | Weak | Weak | **Bailian / Qwen / DeepSeek, works in air-gapped nets** |
| Local file delivery | Mostly text suggestions | Limited | **Script execution + artifact generation + validation** |
| Skill source | Hand-written | Hand-written | **Deposited on success, autonomously reused** |
| Knowledge system | Usually just RAG | Session context | **RAG + traceability + multi-space management** |
| Permission model | Coarse | Medium | **`read-only` / `workspace-write` / `danger-full-access`** |
| Observability | Ad-hoc logs | Vendor-specific | **Opt-in OTLP/JSON + GenAI semconv, plus kernel events** |
| Evolution | Feature iteration | Prompt tuning | **Toward a self-evolving kernel** |

---

## Use Cases (Multi-Industry)

The essence of the "Zhuxing Plan" is **deeply combining AI capability with multiple industries**. Typical directions:

- **Government / Engineering**: spec retrieval, clause traceability, document generation, compliance validation;
- **Legal**: case structuring, precedent libraries, drafting and citation validation;
- **Healthcare**: guideline knowledge bases, care-path deposition, report generation;
- **Manufacturing / Industry**: process knowledge deposition, equipment documentation, QC workflows;
- **Enterprise office**: local document batch processing, report generation, cross-document automation;
- **Research / Education**: literature knowledge bases, survey writing, experiment workflow deposition.

> Common thread: **strong specs, strong delivery, strong compliance, strong knowledge deposition** — exactly the scenarios that need an auditable, traceable, growing agent runtime.

---

## Command Reference

| Command | Description |
| --- | --- |
| `harness run` | Run an agent task (progress / `--json` / `--stream` / `--timing`) |
| `harness dev` | Dev mode: watch plugin changes, hot-reload and re-run |
| `harness login` | Persist credentials interactively |
| `harness config get/set/rm/list` | Read and write persisted configuration |
| `harness session ls/show/rm/archive/unarchive` | Session management (JSONL persistence) |
| `harness space ls/add/rename/rm` | Workspace (project) management |
| `harness models list/stats` | Multi-sub-model management (list / live performance) |
| `harness memory list/add/rm/clear` | Cross-session memory management |
| `harness skill list/add/rm/show/run/create` | Skill management / invocation |
| `harness tools list/test` | List registered tools / try one out |
| `harness list` | List the plugins resolved from configuration |
| `harness validate` | Validate a plugin definition |
| `harness create-plugin` / `install` | Plugin scaffolding / local install |
| `harness plugin-keygen` | Generate an ed25519 signing key pair |
| `harness plugin-sign` | Sign a plugin directory |
| `harness plugin-verify` | Verify a plugin directory against a keyring |
| `harness introspect` | Introspect the runtime's own composition |
| `harness doctor` | Environment self-check (version / config / writable dirs / optional endpoint connectivity) |
| `harness web` | Start the Web UI |
| `harness update` | In-app update |
| `harness completion` | Generate shell completion |
| `harness version` | Print the version |

---

## Documentation

- [docs/quickstart.md](docs/quickstart.md) — Quick start (run it in 5 minutes)
- [docs/cli.md](docs/cli.md) — CLI command reference
- [docs/configuration.md](docs/configuration.md) — Configuration (credentials / patch / profile / sandbox / MCP servers)
- [docs/plugins.md](docs/plugins.md) — Plugin development, permission manifests and signing
- [docs/multi-model.md](docs/multi-model.md) — Multi-sub-model routing & orchestration
- [docs/security.md](docs/security.md) — Security model
- [PLAN.md](PLAN.md) — Design, milestones, commercialization roadmap
- [REPORT.md](REPORT.md) — Optimization results and test findings

---

## License

Dual license (source-available · free for non-commercial use · paid commercial license)

[View LICENSE](LICENSE)

For commercial licensing, private deployment or custom development, contact us (see LICENSE).

---

*"It doesn't just run tasks — it's learning how to run them better."*
