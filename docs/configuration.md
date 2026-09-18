# Configuration

## Credentials and user configuration

Config file: `~/.zhuxing-harness/config.json` (permission 600). The path can be overridden with the `HARNESS_CONFIG` environment variable.

Interactive configuration with `harness login` is recommended; you can also write it manually:

```json
{
  "apiKey": "sk-xxxx",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-v4-flash",
  "workspace": "/path/to/project",
  "level": "workspace-write"
}
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | API Key (higher priority than the config file) |
| `HARNESS_CONFIG` | Config file path |
| `HARNESS_SESSION_DIR` | Session persistence directory |

### `.env`

`run` / `dev` automatically load the workspace `.env` (`KEY=VALUE`), and **do not override** already-existing environment variables.

### Override priority

CLI arguments > environment variables > config file > built-in defaults

## Plugin integration: profile / bundle / patch

A three-layer composition model (inspired by DeepSeek Harness):

- **bundle**: a group of plugins (`plugins:` list)
- **profile**: references multiple bundles + appends patches
- **patch**: overlay operations on the plugin list

```yaml
# patch file (most common)
plugins:
  - id: hello-plugin
    path: ./hello-plugin/src/index.ts
    config: { key: value }   # optional, passed to the plugin's ctx.config
```

```yaml
# profile file
name: my-profile
bundles:
  - ./bundle-a.yml
  - ./bundle-b.yml
patch:
  - op: replace
    id: hello-plugin
    plugin: { id: hello-plugin, path: ./hello-plugin/src/index.ts }
  - op: remove
    id: deprecated-plugin
```

Patch operations: `insert` (overrides by the same id) / `replace` / `remove`.

Usage:

```bash
harness run -p examples/hello-plugin.patch.yml "task"
harness list -p examples/hello-plugin.patch.yml        # view the resolved result
```

> Relative paths are resolved relative to the directory of the config file.

## Sandbox levels

| Level | Commands | Writes |
| --- | --- | --- |
| `danger-full-access` (default) | full access | full access |
| `workspace-write` | commands allowed | paths within the workspace only |
| `read-only` | read-only commands only | all denied |

For stricter, command-level control: `deniedCommands` / `allowedCommands` policies are set in the sandbox plugin config.

## Model defaults

- Endpoint: `https://api.deepseek.com/v1` (any OpenAI-compatible endpoint can be attached via `--base-url` / `config.baseUrl`)
- Models: `deepseek-v4-flash` / `deepseek-v4-pro` (DeepSeek); OpenAI, OpenRouter, local vLLM, etc. can also be attached

## Telemetry (OpenTelemetry, off by default)

Only enabled once an export endpoint is configured — with no endpoint the plugin registers no listeners,
starts no timers and makes **no network requests at all**:

| Environment variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal endpoint, used as-is (e.g. `http://collector:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint, `/v1/traces` is appended (lower priority than the above) |
| `OTEL_SERVICE_NAME` | Resource `service.name`, defaults to `zhuxing-harness` |
| `OTEL_GENAI_CAPTURE_CONTENT` | Set to `1` to capture prompts/replies/tool arguments and results (not captured by default) |

Export follows the OpenTelemetry GenAI semantic conventions (currently Development, attribute names may
evolve); tool execution is exported as `execute_tool <tool name>` spans, batched over OTLP/JSON and flushed
when the plugin is disposed. Export failures are only counted and logged with rate limiting — they never
affect task execution. Note that `OTEL_GENAI_CAPTURE_CONTENT=1` sends user content (credential-redacted)
to that collector.

## MCP servers (stdio, optional)

Add `mcpServers` to the user config (`~/.zhuxing-harness/config.json`). The shape matches Claude Desktop /
Cursor, so configs can be pasted as-is:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": { "KEY": "value" },
      "cwd": "/optional/workdir"
    }
  }
}
```

- **stdio only** (`command` / `args` / `env` / `cwd`); entries with `url` or `type: http|sse` are warned about and skipped
- `command` is required and non-empty; the server name must not contain `__` (it would clash with `mcp__<server>__<tool>`); invalid entries are **warned about and skipped one by one** without affecting other servers or harness startup
- Optional overrides: `timeoutMs` (all three phases), `initTimeoutMs`, `listTimeoutMs`, `callTimeoutMs`; per-result cap `resultMaxBytes` (64KB default, truncated with a notice)
- Tools are registered as `mcp__<server>__<tool>` (the MCP `inputSchema` is used verbatim as the tool schema); servers that fail to connect or negotiate an unsupported version **register no tools**
- Protocol: dual-version negotiation — modern `2026-07-28` (`server/discover` probe + per-request `_meta` carrying version and capabilities) and legacy `2025-06-18` (`initialize` handshake + `notifications/initialized`); any other version from the server causes a **disconnect**; the client declares empty capabilities (no roots / sampling / elicitation)
- Risks (read this): see [Security model · MCP servers](security.md) — attaching merges third-party capabilities into your agent, and the path sandbox cannot constrain files it touches inside its external process
