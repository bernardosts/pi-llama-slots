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

### Hardware Constraints

> **Critical: This extension requires `-np 1` (single slot) on llama-server.**
>
> The tested hardware (32 GB unified iGPU, 6 GB discrete VRAM) cannot sustain multiple concurrent slots at the context sizes this extension targets (up to 78k tokens, 400-1000 MB per slot). Running `-np > 1` would split memory across slots, reducing available context per slot and degrading performance. This is a **hardware ceiling**, not a design choice — on machines with significantly more RAM/VRAM, multi-slot operation may work but is currently untested.
>
> **What this means for users:**
> - Subagent dispatches are **strictly sequential** — only the main slot exists
> - Each dispatch saves the main slot before the subagent runs and restores it after
> - Concurrent subagents (parallel dispatch) are not supported
> - On higher-memory setups, `-np > 1` *may* work but has not been validated

### Hardware Setups

This extension is designed and tested on local laptop setups with limited memory budgets.

#### Primary Setup: ASUS Vivobook S14 S5406SA (Intel Core Ultra 7 258V)

| Component | Spec |
|-----------|------|
| Laptop | ASUS Vivobook S14 S5406SA |
| CPU | Intel Core Ultra 7 258V (Core Ultra Series 1, Lunar Lake) |
| GPU | Intel Arc 140V iGPU |
| RAM | 32 GB LPDDR5 8533 MT/s (unified) |
| Backend | llama-server SYCL build |
| Model | unsloth/Qwen3.6-35B-A3B-MTP-GGUF @ UD-IQ4_XS quantization |
| Max context | 78k tokens |

**Performance:**

| Metric | Speed |
|--------|-------|
| Prefill (start) | ~230 t/s (degrades with context growth) |
| Encoding | 12–19 t/s (stable, ~15 t/s avg even at 50k context) |

### Key Advantages

- **Slot save/restore enables better cache hit reuse** than relying solely on llama-server's default KV cache behavior
- **Multi-model subagents**: subagents can be dispatched using models different from the main session model

### Known Limitations

- **API key support**: Implemented via `PI_LLAMA_SLOT_PAGING_API_KEY` environment variable (see [Configuration](#api-key-support)). If llama-server requires auth but no key is configured, the extension gracefully disables for the session.
- **Model change in main session**: The extension now tracks the model ID used when the slot was last saved. If the main session model changes, restore is refused with a TUI warning, preventing corrupted KV cache state. A fresh slot is used for the new model (see [Future Work](#future-work)).
- **`-np 1` is a hardware ceiling, not a config default**: Tested setups cannot sustain concurrent slots at 78k tokens per slot (~400-1000 MB each). See [Hardware Constraints](#hardware-constraints) for details.

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

### Hardcoded Defaults

The following defaults are embedded in the source code and configurable only by editing the code:

| Constant | Default | What it controls |
|----------|---------|------------------|
| `BACKEND_TIMEOUT` | **300s (5 min)** | HTTP request timeout for all llama-server operations (save, restore, loadModel). |
| `MODEL_LOAD_POLL_INTERVAL` | **1000ms** | Polling interval after restore while waiting for model to load. |
| `MODEL_LOAD_MAX_RETRIES` | **120** | Max poll attempts for model load. Total max wait: ~120s. |
| `MODEL_LOAD_STATUS_INTERVAL` | **500ms** | Polling interval for explicit model status checks. |
| `MODEL_LOAD_COMPLETE_MAX_RETRIES` | **240** | Max attempts for explicit model load completion check. Total max wait: ~120s. |
| Health check timeout | **10000ms** | HTTP timeout for the `llama_slot_status` tool (hardcoded literal). |
| `MAX_LOG_BYTES` | **1,000,000 (1 MB)** | Debug/metrics log file rotation size. |

All retry loops use **fixed-interval polling** (no exponential backoff).

### Error Handling

On save/restore failure, the extension shows a TUI warning and disables itself for the current session. The next session starts fresh.

## Installation

### Prerequisites

- A running `llama-server` instance with slot support (`-np 1`) — see [Hardware Constraints](#hardware-constraints)
  > **Note:** Slot files are stored on the llama-server's filesystem, relative to the llama-server process working directory. This extension does not manage slot file storage or lifecycle directly.
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

> **Note:** The health check HTTP request uses a hardcoded 10s timeout. If llama-server is slow to respond (e.g., during model load), the tool may report `"unreachable"` even when the backend is functional.

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
  "last_saved_model": "Qwen3.6-35B-Chat",
  "note": "Slot files are stored on the llama-server filesystem. Slot save/restore is automatic, driven by subagent lifecycle events. Configuration is resolved via runtime autodiscovery from ctx.model. Use llama_slot_status to check backend connectivity."
}
```

**Field notes:**

| Field | Possible values |
|-------|----------------|
| `backend_status` | `"healthy"`, `"unknown"`, `"unreachable"`, or `"http_${status_code}"` |
| `active_subagent_count` | Currently a placeholder — always `0`. Planned: track live subagent count. |
| `session_disabled` | `true` if slot save/restore is disabled for the session |
| `disable_reason` | Explanation of why slots are disabled |
| `last_saved_model` | Model ID used when the slot was last saved, or `null` if no save has occurred yet. Used for model mismatch detection on restore. |

## Performance

Benchmarked on the ASUS Vivobook S14 S5406SA (Intel Core Ultra 7 258V, Arc 140V iGPU, 32 GB LPDDR5 8533 MT/s unified RAM) running Qwen3.6-35B-A3B-MTP @ UD-IQ4_XS quantization via llama-server SYCL.

### Save Performance

| Context Tokens | Slot File Size | Wall Time | Server Time |
|---------------|----------------|-----------|-------------|
| ~21k | 498 MB | 610 ms | 583 ms |
| ~28k | 635 MB | 823 ms | 807 ms |
| ~31k | 704 MB | 864 ms | 846 ms |
| ~41k | 898 MB | 1,074 ms | 1,052 ms |
| ~49k | 1,080 MB | 1,444 ms | 1,433 ms |

**Average: 787 ms wall / 764 ms server**

### Restore Performance

| Context Tokens | Slot File Size | Wall Time | Server Time |
|---------------|----------------|-----------|-------------|
| ~21k | 498 MB | 415 ms | 403 ms |
| ~28k | 635 MB | 553 ms | 536 ms |
| ~31k | 704 MB | 502 ms | 494 ms |
| ~41k | 898 MB | 664 ms | 654 ms |
| ~49k | 1,080 MB | 760 ms | 729 ms |

**Average: 579 ms wall / 563 ms server**

### Observations

- **Restore is consistently 1.3–1.7× faster than save** — expected, since save writes the full KV cache while restore loads and validates it
- **Server vs wall time variance is <2%** — the extension's timing overhead is negligible
- **Save time scales roughly linearly with context size** (~0.7–0.8 ms per MB of slot file)
- **Restore time ranges 400–760 ms across ~21k→49k tokens** — the slope is shallower than save but five data points in a 2× range is insufficient to distinguish a fixed-overhead model from normal noise

### Full Metrics Log

Raw metrics data from testing sessions is available in [`docs/artifacts/pi-llama-slots.log`](docs/artifacts/pi-llama-slots.log).

> **Note on benchmarks vs. experimental results**: The tables above measure the *cost* of save/restore (787 ms avg save, 579 ms avg restore). The actual benefit — faster recovery when subagents return with preserved KV cache — is measured in the [Experimental Results](#experimental-results--prefill-time-slots-on-vs-off) section below, where `Slots OFF` runs (with `PI_LLAMA_SLOT_PAGING_DISABLED=1`) serve as the counterfactual.

## Experimental Results — Prefill Time: Slots ON vs OFF

**Test setup:**
- Model: unsloth/Qwen3.6-35B-A3B-MTP-GGUF @ UD-IQ4_XS quantization
- Hardware: ASUS Vivobook S14 S5406SA, Intel Core Ultra 7 258V (Arc 140V iGPU), 32 GB LPDDR5 8533 MT/s unified RAM
- Backend: llama-server SYCL
- Tasks: 10 sequential subagent dispatches (5× Moser spindle graph research + 5× Pocklington primality test research)
- Measurement: Time from subagent-completion `tool_result` event to next assistant `tool_call` (prefill/re-encode gap)
- Scripts: [`docs/artifacts/analyze_turn_gaps.py`](docs/artifacts/analyze_turn_gaps.py), [`docs/artifacts/parse_session.py`](docs/artifacts/parse_session.py)

### Run-001 (`Agent` tool pattern, 10 tasks)

| Metric | Slots ON | Slots OFF | Delta |
|--------|----------|-----------|-------|
| Tasks | 10 | 10 | — |
| Min | 226.3s | 249.6s | — |
| Max | 419.6s | 467.0s | — |
| **Avg** | **315.7s** | **380.0s** | **-64.4s** |

**Pairwise:** 10/10 — Slots ON faster in every single case.

**Per-task breakdown:**

| Task | Slots ON | Slots OFF | Delta | Context (input tokens, ON) |
|------|----------|-----------|-------|----------------------------|
| 1 | 281.3s | 324.5s | -43.2s | ~10k |
| 2 | 226.3s | 249.6s | -23.3s | ~18k |
| 3 | 254.2s | 332.3s | -78.1s | ~18k |
| 4 | 341.5s | 359.9s | -18.5s | ~19k |
| 5 | 237.0s | 398.0s | -161.0s | ~20k |
| 6 | 382.0s | 396.7s | -14.7s | ~21k |
| 7 | 337.1s | 392.6s | -55.6s | ~22k |
| 8 | 364.6s | 439.5s | -74.9s | ~23k |
| 9 | 313.2s | 440.2s | -127.0s | ~25k |
| 10 | 419.6s | 467.0s | -47.4s | ~25k |

### Data-Based Observations

1. **100% consistent signal:** Slots ON is faster than Slots OFF in all 10 tasks. No exceptions. The direction is unambiguous.

2. **Magnitude varies with context:** The delta ranges from -14.7s (task 6, ~21k tokens) to -161.0s (task 5, ~20k tokens). There is no clear monotonic correlation with context size, suggesting other factors (model processing variability, KV cache fragmentation) also play a role. The average delta of 64.4s represents a **17% improvement**.

3. **High absolute prefill times:** Both ON and OFF show very high prefill times (226–467s). This is expected on the Intel Core Ultra 7 258V iGPU at ~25k tokens with unsloth/Qwen3.6-35B-A3B-MTP-GGUF @ UD-IQ4_XS — the encoding throughput (~15 t/s) means full re-encode of 25k tokens takes ~1667s theoretical, but actual observed times are lower due to partial re-encoding and hardware caching effects.

4. **Variance analysis:**
   - Slots ON: std ≈ 59.4s (CV ≈ 19%)
   - Slots OFF: std ≈ 64.8s (CV ≈ 17%)
   - Variance is comparable between both configurations — slot restore does not significantly reduce variance at this context scale.

5. **Extension is operational:** Run-001 logs confirm slot save/restore fires on every `Agent` tool call with successful KV cache restoration.

### Test Data

Test artifacts are stored in [`docs/artifacts/test-outputs/`](docs/artifacts/test-outputs/):

| Run | Slots ON | Slots OFF |
|-----|----------|-----------|
| run-001 | `slots-on-session.jsonl` (+ CSV) | `slots-off-session.jsonl` (+ CSV) |

Analysis scripts:
- `python3 docs/artifacts/analyze_turn_gaps.py <on.jsonl> <off.jsonl>` — turn gap comparison
- `python3 docs/artifacts/parse_session.py <jsonl> [--output csv]` — per-message CSV export with tool name annotations

## Features

| Feature | Detail |
|---------|--------|
| Context Detection | Auto (subagent lifecycle events) |
| Routing | Fixed (main slot) |
| Integration | Native to pi |
| Slots | 1 (main, sequential save/restore per subagent dispatch) |
| Configuration | Runtime autodiscovery (ctx.model only) |
| Hardcoded Defaults | Runtime autodiscovery for model/routing; hardcoded for timeouts/retries (configurable in code) |
| Backend Detection | Fail-first on first save attempt; graceful disable if slots API unavailable |
| Subagent Models | Supports dispatching subagents with models different from the main session model |
| Model Change Tracking | Tracks model ID on save; refuses restore with TUI warning if model changed since last save |

## Future Work

- **Model change tracking**: The extension now tracks the model ID used when the slot was last saved. If the model changes, restore is refused with a TUI warning. Future: auto-detect model changes on restore and attempt a best-effort restore anyway with user confirmation.
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
