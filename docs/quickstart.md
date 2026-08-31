# Quick Start

Run your first Agent task within 5 minutes.

## 1. Install

### Option A: Run from source (current)

```bash
git clone <repo>
pnpm install
pnpm build
pnpm harness --help        # or node packages/cli/dist/cli.js --help
```

### Option B: Global command (after release)

```bash
npm install -g @zhuxing/harness
harness --help
```

### Option C: Single-file binary (no Node environment required)

```bash
pnpm bundle                # generates dist-bin/harness.cjs
node dist-bin/harness.cjs version
```

## 2. Configure credentials

```bash
harness login
```

Interactively enter the API Key (default DeepSeek), Base URL, model, workspace, and sandbox level.
Credentials are persisted to `~/.zhuxing-harness/config.json` (permission 600) and output is automatically masked.

You can also use environment variables (no login required):

```bash
export DEEPSEEK_API_KEY=sk-xxxx
# or create a .env at the workspace root: DEEPSEEK_API_KEY=sk-xxxx
```

## 3. Environment self-check

```bash
harness doctor            # version/Key/directory/default level
harness doctor --network  # additionally verifies model endpoint connectivity
```

## 4. Run your first task

```bash
harness run "Summarize the structure of the current directory"
```

The model calls the built-in tools (`list_dir` / `read_file` / `shell` / `write_file`) to complete the task, showing progress in real time:

```
▶ Step 1: calling model…
  ↳ tool list_dir({"path":"."})…
  ✓ list_dir → … 
▶ Step 2: calling model…
✓ step completed
```

### Common options

| Option | Description |
| --- | --- |
| `--stream` | Stream the model response token by token |
| `--json` | Output structured JSON (for scripts) |
| `--timing` | Print per-stage timing |
| `--verbose` | Print the full session trace |
| `-p, --patch <file>` | Attach an external plugin |
| `--level <level>` | Sandbox level (default danger-full-access, highest privilege) |
| `-w, --workspace <dir>` | Workspace |

## 5. Attach a plugin

```bash
# Validate the plugin
harness validate examples/hello-plugin/src/index.ts

# Attach via patch config and run
harness run -p examples/hello-plugin.patch.yml "Call the hello tool to say hi"
```

## 6. Next steps

- [CLI Reference](cli.md)
- [Configuration](configuration.md)
- [Plugin Development](plugins.md)
- [Security Model](security.md)
