# Plugin Development Guide

A plugin is a TypeScript module that exports an `apply(ctx)` function. The kernel calls `apply` when loading it, and automatically cleans up the resources it registered on unmount.

## Minimal plugin

```ts
// my-plugin/src/index.ts
import type { Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const version = '0.1.0'
export const description = 'My first plugin'

export function apply(ctx: Context) {
  ctx.logger.info('[my-plugin] loaded')
}
```

## Three forms

| Form | Usage |
| --- | --- |
| Function | `export function apply(ctx)` + `export const name` |
| Object | `export default { name, apply(ctx) {} }` |
| Class (provides a service) | `export default class extends Service { constructor(ctx) { super(ctx, 'myService') } }` |

## Registering tools (capability as plugin)

```ts
import { defineTool, type Context } from '@zhuxing/harness-sdk'

export const name = 'my-plugin'
export const inject = ['tools']          // declares dependencies; apply runs only when ready

export function apply(ctx: Context) {
  const tools = ctx.inject<import('@zhuxing/harness-sdk').ToolRegistry>('tools')

  const unregister = tools.register(
    defineTool({
      name: 'hello',
      description: 'Say hello to the user',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      execute: (args) => ({ text: `Hello, ${String(args.name)}!` }),
    }),
  )

  ctx.effect(unregister)                 // automatically unregisters the tool on unmount/hot reload
}
```

### Tool execution pipeline

`tools.execute` always goes through: pre-execute interception event → plugin permission adjudication (the plugin's `permissions`) → sandbox guard (declared by the `sandbox` field) → timeout & retry → result normalization.

```ts
execute: (args) => ({ text: '...' })          // success
execute: (args) => ({ error: 'failure reason' })     // failure (does not interrupt the Agent)
```

## ctx API

| API | Description |
| --- | --- |
| `ctx.logger` | structured logging (trace/debug/info/warn/error) |
| `ctx.config` | plugin config (injected via the `config:` field in the patch) |
| `ctx.provide(name, impl)` | register a Service for other plugins to `inject` |
| `ctx.inject(name)` / `injectOptional(name)` | inject a service (optional injection does not throw) |
| `ctx.on(event, listener)` / `once` / `emit` | event subscription and dispatch; a listener returning `false` can reject the event |
| `ctx.effect(disposer)` | register a reversible side effect, executed in reverse order automatically on unmount (idempotent) |
| `ctx.track(promise)` | register in-flight async operations, wait for completion on unmount (with timeout) |

## Event list

| Event | Timing | Interception |
| --- | --- | --- |
| `agent/pre-step` | before each model request | return `false` to reject this request |
| `agent/post-step` | after each step ends | — |
| `tools/before-exec` | before tool execution | return `false` to intercept |
| `tools/after-exec` | after tool execution | — |
| `plugin/mounted` / `plugin/unmounted` | plugin lifecycle | — |

## Declaring dependencies and providing services

```ts
export const inject = ['llm', 'tools']    // dependencies: apply runs only when ready
export const provides = ['my-service']    // provided service names (for dependency topology/cycle detection)
```

- A plugin whose dependencies are not ready enters a pending state, and is automatically mounted once services are registered
- Unmounting a service provider **cascades the unmount** of its consumers
- Circular dependencies are detected and rejected

## Lifecycle and hot reload

- Unmount order: consumers before providers; `ctx.effect` runs in reverse order
- `ctx.effect` must be idempotent (hot reload runs it repeatedly)
- Tool registration must bind cleanup via `ctx.effect(unregister)`, otherwise hot reload leaves residue

## Permission manifest (governance, not isolation)

A plugin may declare `permissions` to constrain resource access **through the harness boundary**:

```ts
export const permissions = {
  fsRead: ['/data/**'],        // read scopes (absolute path prefix or glob)
  fsWrite: ['/tmp/my-plugin'], // write scopes
  shell: ['echo', 'git'],      // command first-word allowlist
  net: ['api.example.com'],    // declaration only (no enforcement point yet)
  env: ['MY_TOKEN'],           // declaration only (same)
}
```

- **Enforcement point**: the tool execution boundary. `args[writeArg] ⊆ fsWrite`, `args[readArg] ⊆ fsRead`,
  command first word of `args[commandArg]` ∈ `shell`; a violation is **refused** with a readable reason and is
  auditable via `tools/after-exec` (`rejectedBy: 'plugin-permissions'`).
- **Capability boundary**: permissions take effect **through the harness boundary, they are NOT process isolation**.
  A plugin is arbitrary in-process JS and can bypass all of this by calling `import('node:fs')` / `child_process`
  directly; plugins without `permissions`, and undeclared dimensions, are unrestricted.
- So it is governance/audit, not a sandbox. The real supply-chain boundary is signature verification below.

## Signature verification (real boundary: refused before load)

Signatures are verified **before a plugin is loaded** (trust root: `HARNESS_PLUGIN_KEYRING` > config `plugins.trustedKeys`):

```bash
harness plugin-keygen --out my-key.pem            # generate an ed25519 key pair (private key is 0600, never commit)
harness plugin-sign ./my-plugin --key my-key.pem  # sign the plugin directory (.harness-signature.json)
harness plugin-verify ./my-plugin                 # verify independently
export HARNESS_PLUGIN_KEYRING="my-key:<public-key base64>"  # once set, loads/installs must verify
```

- The signature covers the digest of **every participating file in the plugin directory**, excluding
  `node_modules/`, `.git/`, `dist/`, `.harness-cache/`, `*.map`, `*.tsbuildinfo` and the signature file itself.
- With a keyring configured: unsigned / untrusted key / invalid signature / content mismatch → **load or install is refused** (fail-closed).
- Without a keyring: existing behavior is preserved (allowed to load) but a notice is printed
  ("plugin signature not verified") — not verifying is not the same as passing.

## Development workflow

```bash
# 1. Scaffold
harness create-plugin my-plugin

# 2. Validate
harness validate my-plugin/src/index.ts

# 3. Attach and run
harness run -p my-plugin.patch.yml "task"

# 4. Hot-reload development
harness dev -p my-plugin.patch.yml "task"   # editing files automatically reloads and reruns
```

## Reference examples

- [examples/hello-plugin](../../examples/hello-plugin) — tool registration + lifecycle cleanup
- [examples/hello-plugin.patch.yml](../../examples/hello-plugin.patch.yml) — integration config
