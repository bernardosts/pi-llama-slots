# Test Scenario: Prefill Time Comparison — Slot Save/Restore vs Full Re-encode

## Objective

Measure the **prefill time** (re-encode overhead) between subagent invocations, comparing:
- **With slots**: llama-server restores a saved KV state snapshot via `llama_slot_save`/`llama_slot_restore` after the subagent returns, ensuring the main session resumes from the same KV state as before the dispatch.
- **Without slots**: llama-server has no saved snapshot, so the main session must re-encode the full context from scratch on the next turn.

The hypothesis: at non-trivial context sizes, slot restore should produce a measurably shorter prefill than full re-encode.

All subagent runs use the same model as the main session (no model switching), so prefill time differences are caused solely by slot state, not by model transitions.

---

## Measurement Methodology

### What we measure

**Prefill time** = time between the `tool_result` event of a `get_subagent_result` call and the timestamp of the **next assistant message** (the LLM's next turn after processing the subagent result).

This captures the full re-encode/prefill cost that the main session experiences upon resuming:
- **Slots ON**: The KV cache snapshot was saved before dispatch and restored after the subagent returned. The prefill should be short because the context is already in the KV cache. **Caveat**: there may be outliers where the restored KV cache pages get evicted by coincidence after restore, so the re-encode still happens anyway — but most of the time, slot restore ensures faster recovery.
- **Slots OFF**: No snapshot exists. The LLM's next turn triggers a full re-encode of the entire context, which should be significantly longer.

### Why not total dispatch time?

Total dispatch time (dispatch → subagent return) includes the subagent's own LLM generation, which dominates the measurement and is not affected by the main session's slot state. The signal we care about — **how fast the main session resumes** — is hidden inside the dispatch time but only visible in the post-return gap.

### How to measure

From the exported session JSONL file, extract for each `get_subagent_result` tool_result:
1. `T_return`: timestamp of the `get_subagent_result` tool_result event
2. `T_next`: timestamp of the next assistant message (the LLM's next turn)
3. `prefill_ms = T_next - T_return`

A parser script is provided at [`analyze_turn_gaps.py`](./analyze_turn_gaps.py) — see below.

---

## Pre-Test: Context-Heavy Session Setup

Before dispatching any subagents, load context to inflate the session window:

1. Read `docs/PLAN.md` (12KB — already in the repo)
2. Read `docs/DIAGNOSIS.md` (~12KB — already in the repo)
3. Optionally read any additional file to push context above ~30k tokens

This gives us a realistic "working session" context. Record the file sizes for reference. Those reads must be made using the read tool, not by delegation.

---

## Test Run Structure

Detect the running environment with `bash: date && echo PI_LLAMA_SLOT_PAGING_DISABLED`. This determines the run type.

### Step 1 — Record Baseline

- **With slots**: Confirm `PI_LLAMA_SLOT_PAGING_DISABLED` is **not** set (or set to `0`)
- **Without slots**: Set `PI_LLAMA_SLOT_PAGING_DISABLED=1` before starting the session
- Note the llama-server model loaded

### Step 2 — Context Loading Phase

Record the time when you finish reading `docs/PLAN.md` and `docs/DIAGNOSIS.md`.
This establishes the "context loaded" baseline time (`T0`).

### Step 3 — Subagent Task 1: Web Research

**Dispatch a subagent with this prompt:**

> Research the "Moser spindle" graph theory problem. Find a recent Wikipedia article about the Moser spindle, including:
> - Its definition and mathematical properties
> - Its significance in graph coloring (chromatic number)
> - A brief history of who introduced it and when
> - Return a summary of ~200 words with key facts and any interesting related results.

**CRITICAL — Sequential dispatch only:**

- Dispatch each subagent **sequentially** — wait for the previous subagent to fully complete before starting the next one.
- **Never dispatch subagents in parallel.** Do NOT call `Agent` more than once concurrently.
- Always use `run_in_background: false` — subagents must run foreground.
- `inherit_context: false` — each subagent gets a fresh context.
- Run this task 5 times in this sequential manner.
- Each subagent uses the same model as the main session (no `model` parameter).

### Step 4 — Subagent Task 2: Different Topic, Different Complexity

**Dispatch a second subagent with this prompt:**

> Research the "Pocklington primality test". Find a Wikipedia article or equivalent authoritative source and provide:
> - The theorem statement and conditions
> - An explanation of why it works (intuition)
> - A worked example with a specific number
> - Its computational complexity compared to general-purpose primality tests
> - Return a summary of ~200 words with the above details.

**CRITICAL — Sequential dispatch only:**

- Dispatch each subagent **sequentially** — wait for the previous subagent to fully complete before starting the next one.
- **Never dispatch subagents in parallel.** Do NOT call `Agent` more than once concurrently.
- Always use `run_in_background: false` — subagents must run foreground.
- `inherit_context: false` — each subagent gets a fresh context.
- Run this task 5 times in this sequential manner.
- Each subagent uses the same model as the main session (no `model` parameter).

### Step 5 — Repeat for Both Configurations

Run the full sequence (Steps 1–4) twice:
1. **Slots ON**: `PI_LLAMA_SLOT_PAGING_DISABLED=0` (or unset)
2. **Slots OFF**: `PI_LLAMA_SLOT_PAGING_DISABLED=1`

---

## Metrics Table

Fill in after collecting data from both configurations:

| Metric | Slots ON | Slots OFF | Delta (ON - OFF) |
|--------|----------|-----------|--------------------|
| Context size (files loaded) | ~24KB+ | ~24KB+ | — |
| Prefill time (avg of 10) | ___ ms | ___ ms | ___ ms |
| Prefill time (min) | ___ ms | ___ ms | ___ ms |
| Prefill time (max) | ___ ms | ___ ms | ___ ms |
| Total session time | ___ ms | ___ ms | ___ ms |

---

## Verification Points (Not a RUN session responsibility — done after artifacts are collected)

1. **Prefill overhead comparison**: Are post-subagent prefill times consistently shorter with slots ON?
2. **Consistency**: Is the trend consistent (slots ON faster) across all runs?
3. **Magnitude**: What's the approximate overhead per dispatch without slots?
4. **Outlier analysis**: Are there outliers in the slots ON data where restore didn't help (KV cache evicted after restore)?
5. **Variance**: Is the variance lower with slots ON (more predictable recovery)?

---

## Notes

### Environment detection
Detect the active configuration via:
```bash
bash: echo "PI_LLAMA_SLOT_PAGING_DISABLED=${PI_LLAMA_SLOT_PAGING_DISABLED:-unset}"
```
- Value is `1` → Slots OFF run
- Value is `0` or unset → Slots ON run

### Agent tool parameters

When dispatching subagents, use these parameters **every time**:

| Parameter | Value | Why |
|-----------|-------|-----|
| `run_in_background` | `false` | Foreground only — ensures sequential execution. Never `true`. |
| `inherit_context` | `false` | Each subagent gets a fresh context. |
| `max_turns` | unset | Default behavior is fine. |

**NEVER dispatch parallel subagents.** All 10 subagent dispatches (5 Task 1 + 5 Task 2) must happen in sequence, one at a time. Parallel dispatch will corrupt the slot save/restore measurements because the main slot may be saved multiple times simultaneously or not at all.

**NEVER specify a `model` parameter.** All subagents use the same model as the main session. Specifying a different model will cause model-unload/load noise that obscures the prefill signal.

### Parser script
After test runs, extract prefill times from the JSONL artifacts using:

```bash
python3 docs/artifacts/analyze_turn_gaps.py <path-to-jsonl>
```

The script outputs: `get_subagent_result` → next tool_call gaps for each run.

See [`analyze_turn_gaps.py`](./analyze_turn_gaps.py) for the full source.

### What about total dispatch time?
Total dispatch time (Agent dispatch → subagent return) is **not** the primary metric. It is dominated by the subagent's own LLM generation and is not affected by the main session's slot state. The prefill gap is the signal we care about.

---

## Success Criteria

If not given the output artifacts of the test runs, that means the success criteria is not your concern. Do not ask for llama server logs or other runs artifacts. Those will be given upfront when available to measure and evaluate the experiment metrics.

The test is considered **successful** if:
- Slots ON shows consistently shorter prefill times than slots OFF (after subagent return)
- The difference is statistically meaningful across the ≥10 total repetitions
- The slot-on condition shows lower dispatch overhead
- The difference is visible both in the JSONL turn gaps and in the extension logs (`wall_restore_slot_ms` vs re-encode times) 

