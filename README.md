# Zhuxing Harness

> **Everything is a plugin · Permission-controlled · Self-growing knowledge · Reusable skills**
> A from-scratch, open-source Agent runtime that keeps learning and accumulating knowledge and skills as you use it.

[![Version](https://img.shields.io/badge/version-0.4.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-Source--Available%20%2F%20Commercial-9c27b0.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-0078d4.svg)](#installation)
[![Status](https://img.shields.io/badge/status-Active%20Development-brightgreen.svg)](#roadmap-toward-a-self-evolving-kernel)

> 中文版请见 [README.zh-CN.md](README.zh-CN.md) · For the Chinese version, see [README.zh-CN.md](README.zh-CN.md).

---

## Table of Contents

- [In One Sentence](#in-one-sentence)
- [What Problems It Solves](#what-problems-it-solves)
- [Core Capabilities](#core-capabilities)
  - [1. Everything Is a Plugin: The Kernel Does No Business Logic](#1-everything-is-a-plugin-the-kernel-does-no-business-logic)
  - [2. Model-Agnostic: You Own Your Model Choice](#2-model-agnostic-you-own-your-model-choice)
  - [3. Three-Tier Permission Sandbox: Bold but Bounded](#3-three-tier-permission-sandbox-bold-but-bounded)
  - [4. Local Operations & File Delivery: From Answers to Artifacts](#4-local-operations--file-delivery-from-answers-to-artifacts)
  - [5. Self-Growing Knowledge Base: From Q&A to Traceable Knowledge](#5-self-growing-knowledge-base-from-qa-to-traceable-knowledge)
  - [6. Skill Deposition & Memory: Compounding Long-Term Experience](#6-skill-deposition--memory-compounding-long-term-experience)
  - [7. Multi-Sub-Model Routing & Orchestration](#7-multi-sub-model-routing--orchestration)
- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [A Complete End-to-End Example](#a-complete-end-to-end-example)
- [Differences From Comparable Projects](#differences-from-comparable-projects)
- [Use Cases (Multi-Industry)](#use-cases-multi-industry)
- [Command Overview](#command-overview)
- [Documentation](#documentation)
- [License](#license)

---

## In One Sentence

**Zhuxing Harness is not "another Chinese version of Claude Code", nor a set of prompt templates.**

It is an **Agent runtime in which plugins are the only primitive**:

- **Privilege-free kernel**: `kernel` only handles context, lifecycle, dependency injection and events — no agent business logic;
- **Pluggable models**: bring your own Key and endpoint, not bound to any single vendor;
- **Everything replaceable**: models, tools, sessions, sandbox, memory, knowledge, skills, the agent loop and CLI output are all plugins — any layer can be swapped or extended via `profile` / `patch` configuration;
- **It compounds**: documents and experiences become searchable, traceable knowledge; proven workflows become reusable skills;
- **And along the way**, it keeps evolving toward a kernel that grows with — and self-evolves alongside — its user.

> If a traditional agent framework is "giving the AI a toolbox", the goal of Zhuxing Harness is: **let the AI grow its own toolbox bigger and more convenient through use.**

---

## What Problems It Solves

| Industry pain point | Zhuxing's answer |
|----------|-----------|
| Mainstream agents are deeply tied to overseas models & accounts, hard for Chinese enterprises to adopt | Fully pluggable models — bring your own Key / BaseURL, compatible with any OpenAI-protocol endpoint (Bailian, Qwen, DeepSeek, etc.) |
| Agent frameworks hard-code business logic into the kernel, hard to customize | Privilege-free kernel; capabilities = plugins, layered `profile` / `patch` config to swap or extend any layer |
| Agents only "talk" — they can't actually operate the machine or deliver files | Local filesystem read/write, script execution, and artifact generation (image / video / speech / code) |
| Knowledge bases are just "document Q&A", discarded after use | Self-growing knowledge base + semantic retrieval + source traceability |
| Agents re-reason from scratch every time, getting more exhausted | Workflows deposited as Skills, experiences as Memory — reusable next time |
| Permission runaway and no audit trail, enterprises won't adopt | Read-only / workspace-write / full-access three-tier isolation, every write & external call is logged |

---

## Core Capabilities

### 1. Everything Is a Plugin: The Kernel Does No Business Logic

Zhuxing's most fundamental design principle: **plugins are the only primitive, the kernel is zero-privilege.**

- `kernel` provides only `Context`, lifecycle, dependency injection (`provide` / `inject`), an event bus (`emit` / `on`) and reversible side-effects (`effect`);
- Models, tools, sessions, sandbox, memory, knowledge, skills, the agent loop and CLI output are all mounted as plugins;
- Plugins discover each other via `provide` / `inject`; on unload they cascade-clean consumers via `effect`, detect circular dependencies and track in-flight tasks;
- Therefore **any capability can be replaced or extended through configuration, without touching the kernel.**

### 2. Model-Agnostic: You Own Your Model Choice

Zhuxing's core principle: **models are plugins, not the foundation.**

- You supply your own **API Key** and **API Base URL** — no vendor is forced on you;
- A unified `OpenAICompatibleProvider` is built on the OpenAI-compatible protocol, with built-in support for Bailian / Qwen, DeepSeek and other endpoints;
- The `Provider` abstraction is clean — integrating a new vendor only requires implementing a `ChatProvider`;
- The agent loop, skills, knowledge base and permission system are completely unaware of the concrete model.

> You can run the whole agent on domestic models in an air-gapped environment with no access to OpenAI or Anthropic. This is "model sovereignty" truly landed in code, not a slogan.

### 3. Three-Tier Permission Sandbox: Bold but Bounded

| Tier | Capability | Typical operations |
|------|------|---------|
| **Read-only** | Observe only, zero side-effects | Read files, list directories, search knowledge |
| **Workspace-write** | Restricted execution, writes only inside the workspace | Generate files, run scripts, write artifacts |
| **Full access (danger-full-access)** | Complete local control | Arbitrary commands, outbound access (requires explicit authorization) |

Design points:

- Every command / write is adjudicated by `Sandbox.checkCommand` / `checkWrite`, with a built-in write-intent blacklist (`rm` / `mv` / `git push` / redirection, etc.);
- Tools declare which argument is guarded via `sandbox: { commandArg, writeArg }`;
- The agent cannot raise its own permissions, nor modify the permission layer itself;
- All writes and external calls are logged in an audit trail.

### 4. Local Operations & File Delivery: From Answers to Artifacts

Zhuxing doesn't just "give you text in a dialog" — it **walks a real workflow and delivers files**:

- Read / search local files and project state (`read_file` / `list_dir`);
- Invoke generation scripts and run builds (`shell`, adjudicated by the sandbox);
- Generate **image / video / speech (TTS) / code / scripts** as real artifacts (`generate_image` / `generate_video` / `text_to_speech`);
- Write artifacts to a target directory and report full paths and re-run commands.

### 5. Self-Growing Knowledge Base: From Q&A to Traceable Knowledge

- Uploaded documents are automatically **chunked** (paragraph-aware, default 800 chars, overlap 120), supporting plain text / docx / pptx / xlsx;
- Configure Embedding (OpenAI-compatible `/embeddings`) to enable **semantic retrieval (RAG)**; when unconfigured it gracefully falls back to keyword matching (CJK bigrams + Latin tokens);
- Supports **multiple spaces / directory trees / scopes** and re-indexing;
- Retrieved content is injected into each dialog's system prompt (8KB cap by default, to prevent context poisoning);
- Q&A is **traceable**: hits are annotated with their source and can be traced back to the original entry;
- For **government, engineering, healthcare, legal, manufacturing** industries, this "spec + clause + traceability" structure is a real prerequisite for adoption.

### 6. Skill Deposition & Memory: Compounding Long-Term Experience

**Skills** — externalize "how to do it" into readable, manageable, versionable files:

- A skill = prompt template (`{{param}}` placeholders) + input JSON Schema + optional tool subset + memory binding;
- Stored as YAML — explainable, auditable, exportable, importable;
- Supports retrieval-based invocation and experience-based reuse; skills compose and parallelize;
- CLI: `harness skill list/run`, plus `use_skill` / `list_skills` tools.

**Memory** — accumulate "cross-session experience":

- Supports `user` / `project` / `auto` / `session` scopes;
- Cross-session memory and session-private memory are auto-injected before each agent run (4KB cap by default).

> This gives the agent **long-term memory + muscle memory**: instead of endlessly stretching context, experience is externalized to disk and reloaded when needed.

### 7. Multi-Sub-Model Routing & Orchestration

As tasks grow, a single model may not suffice. Zhuxing ships multi-sub-model governance:

- **Model registry**: hot-pluggable register / unregister of sub-models;
- **Performance monitoring**: sliding-window metrics per model (latency, success rate);
- **Model selector**: scores by intent-keyword hits + context length + real-time performance weighting to pick the best sub-model;
- **Routing & fallback**: fails over to a backup model automatically, with a unified output format;
- **Orchestrator**: the orchestrator model delegates subtasks to sub-models via the `pick_model` / `list_models` tools, with a unified inter-model protocol.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                      Zhuxing Harness Runtime                │
├────────────────────────────────────────────────────────────┤
│  CLI / Web UI            (entry / chat, works, deliverables)│
│         │                                                   │
│         ▼                                                   │
│  Agent Main Loop         turn/step orchestration + context  │
│         │                                                   │
│  Enhancement Chain      memory → session ctx → KB RAG → skill│
│         │                                                   │
│  Tool Pipeline  before-exec → sandbox adjud. → retry → after│
│         │                                                   │
│  Model Layer            OpenAI-compatible Provider (pluggable)│
│         │                                                   │
│  Local Environment         filesystem · workspace · scripts │
└────────────────────────────────────────────────────────────┘
```

Key design principles:

1. **Privilege-free kernel**: Context / lifecycle / DI / events, no business logic;
2. **Capability = plugin**: models, tools, sessions, sandbox, memory, knowledge, skills, loop — all replaceable;
3. **Models are replaceable adapters**, not the foundation;
4. **Permission is a cross-cutting concern** threaded through every tool call;
5. **Knowledge / skills / memory are externalized experience**, versionable, exportable, shareable.

---

## Quick Start

> Run via npm or from source.

### Installation

After publishing to npm: `npm install -g @zhuxing/harness`

From source: run `pnpm install`, then `pnpm build`, and use the `harness` command (or `node packages/cli/dist/cli.js`).

### Windows installer (NSIS, redistribution)

```bash
pnpm build
pnpm bundle
pnpm --filter @zhuxing/harness-web build:ui
node scripts/build-nsis.mjs        # generates dist-install/zhuxing-harness-setup-<version>.exe
```

Installer features: no admin required (installs to `%LOCALAPPDATA%\ZhuxingHarness`), bundles a portable Node runtime, start-menu shortcut and uninstaller; ready to use after install with `harness run` / `harness web`.

### Command line

```bash
# 1. Configure credentials (one-time, interactive)
harness login

# 2. Run your first task
harness run "Summarize the structure of the current directory"

# 3. Attach a plugin (via patch config)
harness run -p examples/hello-plugin.patch.yml "Use the hello tool to greet"
```

Web UI: `harness web` (default http://127.0.0.1:3080). Environment self-check: `harness doctor [--network]`.

> ⚠️ It's recommended to run in the **sandbox tier** first, and open up permissions as you get familiar.

---

## A Complete End-to-End Example

This chain shows Zhuxing Harness's "**learn → do → record → grow**" loop:

**① Assign the task**
> "Generate the 0.3.8 user manual and validate version consistency."

**② Execute autonomously**
- Read project files and historical sessions;
- Locate the generation script `scripts/gen-user-manual.cjs`;
- Run it through the sandbox to produce `.docx` and `.pdf`;
- Auto-validate version number, title, page count, path consistency.

**③ Deliver artifacts**
```
dist/ZhuxingHarness-user-manual-0.3.8.docx
dist/ZhuxingHarness-user-manual-0.3.8.pdf
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
| Kernel role | Often hard-codes business logic | Bound to Anthropic | **Privilege-free kernel, capabilities as plugins** |
| Model binding | Often single-vendor | Single ecosystem | **Fully pluggable, OpenAI-compatible** |
| Domestic ecosystem | Weak | Weak | **Bailian / Qwen / DeepSeek, works in air-gapped nets** |
| Local file delivery | Mostly text suggestions | Limited | **Script execution + artifact generation + validation** |
| Skill source | Hand-written | Hand-written | **Deposited on success, autonomously reused** |
| Knowledge system | Usually just RAG | Session context | **RAG + traceability + multi-space management** |
| Permission model | Coarse | Medium | **Read-only / workspace-write / full three tiers** |
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

## Command Overview

| Command | Description |
| --- | --- |
| `harness run` | Run an agent task (progress / `--json` / `--stream` / `--timing`) |
| `harness dev` | Dev mode: watch plugin changes, hot-reload and re-run |
| `harness login` / `harness config` | Credential & configuration persistence |
| `harness session ls/show/rm` | Session management (JSONL persistence, fork / replay) |
| `harness models list/stats` | Multi-sub-model management (list / real-time performance) |
| `harness memory list/get` | Cross-session memory management |
| `harness skill list/run` | Skill management / invocation |
| `harness validate` | Validate plugin definitions |
| `harness create-plugin` / `install` | Plugin scaffolding / local install |
| `harness list` | List the plugins resolved from configuration |
| `harness doctor` | Environment self-check |
| `harness completion` | Shell completion |
| `harness version` | Version number |

---

## Documentation

- [docs/quickstart.md](docs/quickstart.md) — Quick start (run it in 5 minutes)
- [docs/cli.md](docs/cli.md) — CLI command reference
- [docs/configuration.md](docs/configuration.md) — Configuration (credentials / patch / profile / sandbox)
- [docs/plugins.md](docs/plugins.md) — Plugin development guide
- [docs/multi-model.md](docs/multi-model.md) — Multi-sub-model routing & orchestration
- [docs/security.md](docs/security.md) — Security model
- [PLAN.md](PLAN.md) — Design, milestones, commercialization roadmap
- [REPORT.md](REPORT.md) — Optimization results and test findings

---

## License

Dual license (source-available · free for non-commercial use · paid commercial license)

[View LICENSE](LICENSE) · 中文 [LICENSE](LICENSE)

For commercial licensing, private deployment or custom development, contact us (see LICENSE).

---

*"It doesn't just run tasks — it's learning how to run them better."*
