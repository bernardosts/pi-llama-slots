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
- **Model change in main session**: The extension now tracks the model ID used when the slot was last saved. If the main session model changes, restore is refused with a TUI warning, preventing corrupted KV cache state. A fresh slot is used for the new model (see [Future Work](#future-work)).
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

- A running `llama-server` instance with slot support (`-np 1`)
  > **Note:** `-np 1` is a hardware ceiling on the tested machines (32 GB unified iGPU, 6 GB VRAM). Values above 1 require memory headroom not available on those setups. See [Known Limitations](#known-limitations).
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

Benchmarked on a laptop with an Intel Core i7 (13th Gen) + NVIDIA RTX 4050 (6 GB VRAM), running Qwen3.6-35B-A3B @ IQ4_XS quantization.

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

> **Missing counterfactual data**: This section shows the *cost* of save/restore (787 ms wall save, 579 ms wall restore). It does **not** show the *benefit* — dispatch latency with paging on vs `PI_LLAMA_SLOT_PAGING_DISABLED=1` at matched context sizes. That comparison (dispatch latency with KV cache preserved vs. full re-encode) is the key metric for net usefulness and is not yet available.

## Experimental Results — Prefill Time: Slots ON vs OFF

**Test setup:**
- Model: Qwen3.6-35B-A3B-MTP @ IQ4_XS quantization
- Hardware: Intel Core Ultra 7 258V (Arc 140V iGPU), 32 GB unified memory
- Task: Two research subagent tasks (Moser spindle graph, Pocklington primality test)
- Measurement: Time from subagent-completion `tool_result` event to next assistant `tool_call` (prefill/re-encode gap)
- Scripts: [`docs/artifacts/analyze_turn_gaps.py`](docs/artifacts/analyze_turn_gaps.py)

### Run-001 (original `get_subagent_result` pattern)

| Metric | Slots ON | Slots OFF | Delta | Direction |
|--------|----------|-----------|-------|-----------|
| Tasks | 2 | 2 | — | — |
| Min | 6.4s | 11.0s | — | — |
| Max | 7.6s | 133.6s | — | — |
| **Avg** | **7.0s** | **72.3s** | **-65.3s** | **ON faster** |

**Pairwise:** 2/2 — Slots ON faster in every case.

**Key finding:** The OFF Task 2 took 133.6s vs ON's 7.6s (17.6x worse). Context was ~18k tokens by that point — without a saved KV cache, the full re-encode cost compounded.

### Run-002 (newer `Agent` tool pattern)

| Metric | Slots ON | Slots OFF | Delta |
|--------|----------|-----------|-------|
| Tasks | 7 | 5 | — |
| Min | 61.0s | 80.5s | — |
| Max | 75.5s | 99.7s | — |
| **Avg** | **68.5s** | **86.2s** | **-17.7s** |

**Pairwise:** 5/5 — Slots ON faster in every case.

**Consistency:** Slots ON shows very tight variance (61-75s, std ~4.5s) vs OFF (80-100s, std ~7.2s).

### Run-002 Extension Log Evidence

8 successful `restore_full` operations, each restoring **400-500MB** of KV cache (16k-21k tokens). The `wall_restore_slot_ms` component was consistently **282-364ms** — the actual slot restore time. The bulk of the ~18-22s wall time per restore comes from `wall_restore_wait_ms` (15-21s), which is the model load/reload time while waiting for the subagent to complete.

### Data-Based Observations

1. **Consistent signal across both runs:** Slots ON is faster than Slots OFF — 2/2 in run-001, 5/5 in run-002. The direction is unambiguous.

2. **Magnitude varies by context growth:** The savings are huge in run-001 (65s avg) but more modest in run-002 (18s avg). Run-002's absolute times (61-99s) are much higher overall, suggesting the base model load is dominant and slot restore only saves the incremental re-encode portion. As context grows, the saved KV cache prevents progressive re-encode cost accumulation.

3. **Outlier analysis — run-001 OFF:** The 133.6s OFF time on task 2 shows what happens when context grows without slot preservation — without a saved KV cache, the full re-encode cost compounds with each dispatch.

4. **Variance reduction:** Slots ON provides more predictable recovery times, with ~40% lower standard deviation in run-002 (4.5s vs 7.2s).

5. **Extension is operational:** Run-002 logs confirm slot save/restore fires on every subagent cycle with successful KV cache restoration at 400-500MB per snapshot.

### Test Data

Test artifacts are stored in [`docs/artifacts/test-outputs/`](docs/artifacts/test-outputs/):

| Run | Slots ON | Slots OFF |
|-----|----------|-----------|
| run-001 | `test-scenario-slots-on.jsonl` | `test-scenario-slots-off.jsonl` |
| run-002 | `slots-on-session.jsonl` | `slots-off-session.jsonl` |

Analysis output: `python3 docs/artifacts/analyze_turn_gaps.py <on.jsonl> <off.jsonl>`

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
