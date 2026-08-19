# pi-llama-slot-paging

Pi extension that automatically manages llama-server slot save/restore at the harness level for the orchestrator pattern.

> **Note on naming**: "paging" refers to the save/restore cycle of slot state across subagent dispatches — not memory paging. Each subagent dispatch triggers a save before dispatch and a restore after completion.

## Motivation

**pi-llama-slot-paging** was built to make the orchestrator pattern bearable on resource-constrained local laptops where context windows grow with every subagent dispatch.

### The Problem

When delegating to subagents in an orchestrator loop, the main session's context grows with every round-trip. On a local llama-server, this context lives in RAM — and on a laptop with 32 GB unified memory, you quickly run out of room. Without slot save/restore, llama-server's default KV cache behavior degrades to a crawl as context grows, making subagent dispatches painfully slow.

### The Solution

By saving the main slot before each subagent dispatch and restoring it after, the orchestrator resumes with a **cached KV state**. This means:

- **Better cache hits** than relying on llama-server's default cache behavior alone
- **Lower latency** for subsequent dispatches — the model doesn't need to re-encode the full context
- **Feasible multitasking** — the laptop remains usable (browser, calls, music, VSCode) because the slot approach keeps memory pressure manageable

### Hardware Setups

This extension is designed and tested on local laptop setups with limited memory budgets.

#### Primary Setup: Intel Core Ultra 7 258V (Arc 140V iGPU)

| Component | Spec |
|-----------|------|
| CPU | Intel Core Ultra 7 258V |
| GPU | Arc 140V iGPU |
| RAM | 32 GB unified system memory |
| Backend | llama-server SYCL build |
| Model | Qwen3.6-35B-A3B-MTP @ IQ4_XS quantization |
| Max context | 78k tokens |

**Performance:**

| Metric | Speed |
|--------|-------|
| Prefill (start) | ~230 t/s (degrades with context growth) |
| Encoding | 12–19 t/s (stable, ~15 t/s avg even at 50k context) |

#### Secondary Setup: Intel 13th Gen Core i7 + RTX 4050

| Component | Spec |
|-----------|------|
| CPU | Intel Core i7 13th Gen |
| GPU | NVIDIA RTX 4050 (6 GB VRAM) |
| RAM | 32 GB system memory |
| Backend | llama-server CUDA build |
| Model | Qwen3.6-35B-A3B-MTP @ IQ4_XS quantization |

**Performance:**

| Metric | Speed |
|--------|-------|
| Prefill (start) | ~300 t/s (degrades with context growth) |
| Decoding (start) | ~29 t/s (degrades with context growth, but not unbearable) |

### Key Advantages

- **Slot save/restore enables better cache hit reuse** than relying solely on llama-server's default KV cache behavior
- **Multi-model subagents**: subagents can be dispatched using models different from the main session model

### Known Limitations

- **API key support**: Implemented via `PI_LLAMA_SLOT_PAGING_API_KEY` environment variable (see [Configuration](#api-key-support)). If llama-server requires auth but no key is configured, the extension gracefully disables for the session.
- **Model change in main session**: if the model used by the main session changes during a session, this can cause crashes or side effects. Slot state is model-specific, and a model switch invalidates the cached KV state. This needs to be tracked and handled properly (see [NEXT_ITEMS.md](docs/NEXT_ITEMS.md)).
- **`-np 1` is a hardware ceiling, not a config default**: Tested setups (32 GB unified iGPU, 6 GB VRAM discrete) don't have memory headroom for concurrent slots at the context sizes this extension targets (up to 78k tokens). Per-subagent slots (multi-slot pool) would require `-np > 1` and meaningfully more VRAM/RAM than either tested machine has — not planned for this hardware class, untested on higher-memory setups.

## Built With Itself

This entire extension was developed using **pi + local Qwen**, with the orchestrator pattern and slot save/restore active throughout the entire development cycle.

Every feature, every bug fix, every refactor was done through the exact workflow this extension enables — dispatching subagents, saving/restoring the main slot, and resuming with cached context. The tooling works because it was built by the tooling itself.

## Architecture

```
┌─────────────────────────────────────────┐
│              Pi Session                  │
│                                          │
│  ┌──────────────────────┐                │
│  │   Orchestrator       │                │
│  │                      │                │
│  │  Agent{subagent}     │───┐            │  ← `Agent` tool (from @tintinweb/pi-subagents)
│  │                      │───┼──► dispatch│
│  └─────────┬────────────┘    │            │
│            │                 │ extension  │
│            │                 │ auto-saves │
│            │                 │ main slot  │
│            │                 │ on every   │
│            │                 │ subagent   │
│            │                 │ lifecycle  │
│            │                 │ event      │
│            │                 │            │
│            ▼                 │            │
│  ┌──────────────────┐       │            │
│  │  Subagents       │◄──────┘            │  ← can use different models
│  │  (sequential     │
│  │   save/restore)  │
│  └──────────────────┘                     │
└──────────────┬───────────────────────────┘
               │  OpenAI-compatible API
               ▼
┌─────────────────────────────────────────┐
│        llama-server (-np 1)             │
│                                          │
│  Slot 0:                                 │
│    main             ← orchestrator +     │
│                      subagents context   │
└─────────────────────────────────────────┘
```

## How It Works

Slot save/restore is **automatic** — no orchestrator tool calls needed:

1. **A subagent is dispatched** → extension calls `/slots/0?action=save` with `filename="main"` (on every `Agent` tool call)
2. **Subagent runs** → uses the saved slot context (sequential save/restore per dispatch)
3. **A subagent completes or fails** → extension calls `/slots/0?action=restore` with `filename="main"`

This ensures the orchestrator always resumes with cached context, minimizing latency for subsequent dispatches.

> **Note**: Subagents can be dispatched using models different from the main session model. The slot save/restore only affects the main session's context — subagents operate with their own model's KV cache.

## Configuration

The extension uses **runtime autodiscovery** from `ctx.model` — no config files needed.

### Disabling the Extension

Set the environment variable to explicitly disable:

```bash
export PI_LLAMA_SLOT_PAGING_DISABLED=1
```

Accepted values: `1`, `true`, `yes` (case-sensitive).

### Debug Logging

Enable verbose debug logging to `./pi-llama-slots.log`:

```bash
export PI_LLAMA_SLOT_PAGING_LOGGING=1
```

Accepted values: `1`, `true`, `yes` (case-sensitive).

### API Key Support

If llama-server is started with `--api-key`, configure the extension to match:

```bash
export PI_LLAMA_SLOT_PAGING_API_KEY="your-api-key-here"
```

The key is sent as `Authorization: Bearer <key>` on all fetch calls. The value is **never logged** — only presence and key length appear in debug logs.

If llama-server requires auth but no key is configured, the extension detects 401/403 responses, shows a TUI warning, and disables slot save/restore for the session (graceful degradation).

### Error Handling

On save/restore failure, the extension shows a TUI warning and disables itself for the current session. The next session starts fresh.

## Installation

### Prerequisites

- A running `llama-server` instance with slot support (`-np 1` or lower)
- The `@tintinweb/pi-subagents` package (provides the `Agent` tool that this extension hooks into)

### Setup

1. The extension is auto-discovered via `package.json` (`pi.extensions` field pointing to `./src/index.ts`).
   No `pi install` needed for project-local extensions.

2. Runtime autodiscovery works automatically — no config file needed.

3. To use the orchestrator agent, set up your session to use `subagent_type: "orchestrator"` or reference it in your system prompt.

## Tools

Only one tool is registered by this extension:

### `llama_slot_status`

Checks backend connectivity, resolved model configuration, and reports available slots.

**Parameters:** None

**Returns:**

```json
{
  "backend_url": "http://192.168.3.7:8080",
  "model_id": "Qwen3.6-35B-Chat",
  "backend_status": "healthy",
  "active_subagent_count": 0,
  "available_slots": [
    { "name": "main", "file": "main" }
  ],
  "note": "Slot files are stored on the llama-server filesystem. Slot save/restore is automatic, driven by subagent lifecycle events. Configuration is resolved via runtime autodiscovery from ctx.model. Use llama_slot_status to check backend connectivity."
}
```

**Field notes:**

| Field | Possible values |
|-------|----------------|
| `backend_status` | `"healthy"`, `"unknown"`, `"unreachable"`, or `"http_${status_code}"` |
| `active_subagent_count` | Currently a placeholder — always `0`. Planned: track live subagent count. |

## Features

| Feature | Detail |
|---------|--------|
| Context Detection | Auto (subagent lifecycle events) |
| Routing | Fixed (main slot) |
| Integration | Native to pi |
| Slots | 1 (main, sequential save/restore per subagent dispatch) |
| Configuration | Runtime autodiscovery (ctx.model only) |
| Hardcoded Defaults | Runtime autodiscovery for model/routing; hardcoded for timeouts/retries (configurable in code) |
| Subagent Models | Supports dispatching subagents with models different from the main session model |

## Future Work

- **Non-llama endpoint detection**: Detect when the backend does not support the llama slots API and gracefully disable the extension for the remainder of the session.
- **Model change tracking**: Detect when the main session model changes and handle gracefully (save/restore state is model-specific).
- **One slot per subagent**: Currently all subagents share the `main` slot. Future: one slot per subagent.
- **Slot status monitoring**: Track which slot is currently active.
- **Pruning**: LRU eviction for slot files when storage grows too large.

## Files

```
src/
├── index.ts                    # Extension entry point
├── slot-client.ts              # Slot save/restore operations
├── slot-status.ts              # Status tool
package.json                    # Package manifest (pi.extensions)
tsconfig.json                   # TypeScript configuration
AGENTS.md                       # Project rules
README.md                       # This file
```
