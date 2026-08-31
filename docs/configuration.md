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
