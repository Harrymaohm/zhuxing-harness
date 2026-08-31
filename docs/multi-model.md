# Multi-Submodel Routing and Orchestration

The multi-model capability under the "everything is a plugin" system: the main orchestrating model (the main model) dynamically selects and delegates sub-models to execute subtasks based on task requirements, context, and real-time performance metrics. All capabilities are mounted as the `harness-model-router` plugin, and can be replaced or unmounted as a whole.

## Architecture

```
Main orchestrating model (main model, id: default)
        │  calls tools pick_model / list_models
        ▼
ModelOrchestrator (inter-model communication protocol: delegate / listModels)
        │
        ▼
ModelRouter (unified interaction entry point, implements ChatProvider)
   ├── ModelSelector   selection algorithm (task intent + context fit + performance score)
   ├── ModelRegistry   model registry (hot-pluggable: register returns a disposer)
   └── ModelMonitor    real-time performance monitoring (sliding window: success rate/latency/token/cost)
        │
        ▼
Sub-models A / B / C … (OpenAI-compatible providers, uniformly output ChatResult)
```

- **Plugin management framework**: `ModelRegistryImpl` supports register/unregister at runtime; `register()` returns a disposer, and binding it to `ctx.effect` cleans it up automatically when the plugin unmounts (safe hot-plugging).
- **Model selection algorithm**: score = capability match ×0.5 + context fit ×0.2 + performance metrics ×0.3 (weights configurable). Task intent is analyzed based on a built-in Chinese/English keyword vocabulary; context estimates tokens by character count and compares against the model window; performance takes the sliding-window success rate and latency.
- **Inter-model communication protocol**: the orchestrating model calls the `pick_model` tool to delegate subtasks, returning a unified format `{ ok, modelId, content, usage, latencyMs, estCost, error? }`; `list_models` returns the available models and real-time metrics for decision-making.
- **Unified interaction interface**: `ModelRouter` implements `ChatProvider` (chat/stream); whichever sub-model is selected, the output is a consistent `ChatResult` (the actual model id is attached in `raw.__modelId`).
- **Failure degradation**: when the preferred sub-model fails, the next-best candidate is tried automatically (`fallback` is enabled by default).

## Configuring sub-models

Persistent config (the `models` field in `~/.zhuxing-harness/config.json`, or `harness config set models '<json>'`):

```json
{
  "models": [
    { "id": "coder", "model": "deepseek-coder", "capabilities": ["code"], "contextWindow": 64000 },
    { "id": "fast", "model": "deepseek-v4-flash", "capabilities": ["fast", "general"], "contextWindow": 8000, "costPer1k": 0.001 },
    { "id": "long", "model": "deepseek-v4-pro", "capabilities": ["analysis", "long-context"], "contextWindow": 200000, "baseUrl": "https://api.deepseek.com/v1" }
  ]
}
```

Field description:

| Field | Description |
| --- | --- |
| `id` | unique identifier of the sub-model (required) |
| `model` | OpenAI-compatible model name (required) |
| `capabilities` | capability tags: `code` / `reasoning` / `creative` / `analysis` / `fast` / `cheap` / `long-context` / `general` |
| `contextWindow` | context window (tokens), used for context-fit scoring |
| `costPer1k` | estimated cost per thousand tokens (CNY), used for cost monitoring |
| `baseUrl` / `apiKey` | endpoint and key (fall back to the main config if omitted) |
| `timeoutMs` | request timeout |

Temporary override from the command line:

```bash
harness run --models '[{"id":"coder","model":"deepseek-coder","capabilities":["code"]}]' "Write a sorting function"
```

## Usage

```bash
harness models list                 # list registered sub-models
harness models stats                # real-time performance metrics (success rate/latency/calls/token/cost)
harness run --model-id coder "Refactor this code"   # explicitly specify a sub-model (skips automatic selection)
harness run "Summarize this repository"            # automatic selection: the orchestrating model can call pick_model to delegate subtasks
```

Web end: `config.models` takes effect automatically; `GET /api/models` returns the current config. The Web UI "Settings" panel provides sectional configuration:

- **Main model**: API Key / Base URL / model name (main orchestrating model)
- **Sub-models**: card-based add/remove, each item includes model ID, model name, display name, context window, capability tags (click-to-select), independent endpoint and Key (fall back to the main config if omitted)
- **Image model**: model name / endpoint / Key / default size; once configured the Agent gains the `generate_image` tool (OpenAI-compatible `/images/generations`)
- **Runtime environment**: workspace, sandbox level

Key security: `GET /api/config` returns the main Key, sub-model Keys, and image Key all masked; on the frontend, save does not send back keys that were not modified, and the server merges the old values by model id.

## Programmatic interface

```ts
import {
  ModelRegistryImpl, ModelMonitorImpl, ModelSelectorImpl,
  ModelRouterImpl, ModelOrchestratorImpl,
} from '@zhuxing/harness-model-router'

const registry = new ModelRegistryImpl()
const monitor = new ModelMonitorImpl()
const selector = new ModelSelectorImpl(registry, monitor)
const router = new ModelRouterImpl(registry, monitor, selector)

const dispose = registry.register({ id: 'coder', capabilities: ['code'] }, provider)
const result = await router.chat(messages)          // automatic selection + degradation
const orchestrator = new ModelOrchestratorImpl(registry, monitor, router)
const sub = await orchestrator.delegate({ task: 'compute 1+1' })  // unified-format result
dispose()                                            // hot-plug: unregister the sub-model
```

Service names inside the bundle: `modelRegistry` / `modelMonitor` / `modelSelector` / `modelRouter` / `orchestrator`.
