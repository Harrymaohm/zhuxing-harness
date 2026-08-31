# CLI Reference

Exit codes: `0` success · `1` runtime error · `2` usage error

## Global

```bash
harness --help | -h     # help
harness --version | -v  # version
```

## run — Run an Agent task

```bash
harness run [options] "task description"
```

| Option | Description |
| --- | --- |
| `-p, --patch <file>` | patch overlay, may be specified multiple times |
| `--profile <file>` | profile composition file |
| `--api-key <key>` | API Key (default: config → environment variables) |
| `--base-url <url>` | OpenAI-compatible endpoint (default `https://api.deepseek.com/v1`) |
| `--model <name>` | model name (default `deepseek-v4-flash`) |
| `-w, --workspace <dir>` | workspace (default: config or current directory) |
| `--level <level>` | `read-only` / `workspace-write` / `danger-full-access` (default `danger-full-access`) |
| `--max-steps <n>` | maximum steps (default 20) |
| `--temperature <t>` | sampling temperature |
| `--system-prompt <s>` | custom system prompt |
| `--session-dir <dir>` | session persistence directory (default `~/.zhuxing-harness/sessions`) |
| `--stream` | stream output token by token |
| `--json` | structured JSON output |
| `--summary` | collapse the final output into a delivery summary (full data retained in the session log) |
| `--timing` | print per-stage timing |
| `--verbose` | print the full session trace |
| `--log-level <l>` | `trace`/`debug`/`info`/`warn`/`error` |

Examples:

```bash
harness run "Fix the bug in src/index.ts" --level workspace-write
harness run --json --timing "Summarize the repository"           # for script consumption
harness run --stream "Explain what an Agent harness is"   # streaming
```

`--json` output structure: `{ ok, content, steps, finishedReason, sessionId, timing? }`

## dev — Development mode (hot reload)

```bash
harness dev [options] "task description"
```

Watches the patch plugin entry file; on change it automatically unmounts → remounts → reruns the task. Exit with `Ctrl-C`.

## login — Interactive configuration

```bash
harness login
```

Enter the API Key / Base URL / model / workspace / sandbox level in sequence, written to `~/.zhuxing-harness/config.json`.

## config — Configuration management

```bash
harness config list                      # list (apiKey auto-masked)
harness config get <key>
harness config set <key> <value>
harness config rm <key>
```

Common keys: `apiKey` / `baseUrl` / `model` / `workspace` / `level`.

## session — Session management

```bash
harness session ls                       # list sessions (prefix id + event count + time)
harness session show <id or prefix>          # view a session trace
harness session rm <id or prefix>            # delete a session
```

Sessions are persisted to `~/.zhuxing-harness/sessions/*.jsonl` (overridable with `HARNESS_SESSION_DIR`).

## validate — Validate a plugin

```bash
harness validate <plugin path>              # supports .ts / .js
```

Outputs plugin metadata and development-time suggestions.

## create-plugin — Scaffolding

```bash
harness create-plugin <name>
```

Generates a plugin template demonstrating three capabilities: tool registration / event subscription / lifecycle cleanup.

## install — Install a local plugin

```bash
harness install <plugin source dir> [--as <name>]
```

Copies into `plugins/` and outputs an integration config snippet. `plugins/` is a local artifact (gitignored).

## list — Resolve plugin config

```bash
harness list [--patch <file>] [--profile <file>]
```

## doctor — Environment self-check

```bash
harness doctor [--network]
```

Checks: Node version, API Key (masked), session directory writable, default sandbox level, model defaults; `--network` additionally verifies endpoint connectivity.

## completion — Shell completion

```bash
harness completion bash | zsh
```

## Config override priority (run/dev)

CLI arguments > environment variables (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`) > config file > defaults
