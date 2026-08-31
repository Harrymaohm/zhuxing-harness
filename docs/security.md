# Security Model

## Design principles

1. **Highest privilege by default**: the sandbox defaults to `danger-full-access`, with no restriction on informational queries or write operations; it can be downgraded via `--level` or config
2. **Downgrade on demand**: for untrusted environments / sensitive directories, it is recommended to downgrade to `workspace-write` or `read-only`
3. **Credential protection**: persistence + output masking + file permissions
4. **Traceability**: everything the model can see is recorded in session logs and is auditable

## Three-tier sandbox policy

| Level | Command execution | File writes |
| --- | --- | --- |
| `danger-full-access` (default) | all allowed | all allowed |
| `workspace-write` | commands allowed | paths within the workspace only |
| `read-only` | read-only commands only; only blocks explicit write intent | all denied |

**read-only blocks write intent only, allows read-only queries**:

- ✅ Allowed: `git status/log/diff`, `grep/find/cat/head/tail/ls`, `sed` queries (no `-i`), `awk` queries, `npm view`, `pip list`, `curl` queries (no `-o`), `echo $VAR`
- ⛔ Blocked: `rm/mv/cp/mkdir/touch`, `sed -i` (in-place write), `curl -o` (download writes a file), `npm install/publish/run`, `echo > file`, `vi/vim` editing, `git push/commit/tag`, `wget`, `chmod/chown`, `dd/mkfs/format`

Fine-grained command control: `deniedCommands` (highest priority) / `allowedCommands` (allowlist).

## Credential security

- **Storage**: `~/.zhuxing-harness/config.json`, file permission 600
- **Input**: interactive entry via `harness login`, avoiding plaintext on the command line
- **Output masking**: all CLI output (progress/results/traces/errors/doctor) is masked via `maskSecrets()`; `sk-` tokens are shown as `sk-***xxx`
- **Environment variables**: `DEEPSEEK_API_KEY` as a fallback, avoiding writing to command history

> Once a Key leaks into a conversation/log/screenshot, it should be rotated immediately from the provider console.

## Tool execution security

The tool execution pipeline is unified: pre-execution interception (policy plugins can reject) → sandbox guard → timeout (default 60s) → retry → result normalization.

Tools declared with a `sandbox` field (such as `shell`, `write_file`) are automatically adjudicated by policy before execution.

## Plugin trust boundary

- Plugins can read/write the workspace, execute commands, and inject services — **only load plugins from trusted sources**
- `harness validate` validates plugin definitions (dependencies/services/config schema)
- Hot reload/unmount guarantees resource cleanup, avoiding dangling references and residue

## Sessions and audit

- Session logs are written append-only (`~/.zhuxing-harness/sessions/*.jsonl`)
- `harness session show <id>` can replay the full trace (system prompts, requests, tool results are all recorded)
- Log output is uniformly masked and never writes credentials

## Recommendations

1. Pin the sandbox level in production and refine `deniedCommands`
2. When using `danger-full-access` in service-oriented/unattended scenarios, be sure to isolate the environment
3. Rotate the API Key regularly; restrict plugin sources for sensitive projects
