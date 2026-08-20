# NEXT_ITEMS.md — Pending Work

## 1. Pruning / LRU Eviction

**Priority:** Low
**Status:** Not implemented

**Problem:** Slot files accumulate on the llama-server filesystem over time. There is no cleanup mechanism, which can lead to disk space issues during long sessions.

**What needs to happen:**
- Implement LRU (Least Recently Used) eviction for slot files
- Configurable max number of slot files or max disk usage
- Automatic cleanup when limits are exceeded
- Never evict the currently active slot

**Acceptance criteria:**
- Slot files are evicted when LRU threshold is reached
- Currently active slot is never evicted
- Configurable limits via environment variables or config
- Cleanup happens automatically without user intervention

---

## 2. Counterfactual Benchmark

**Priority:** High
**Status:** Not started — requires live testing

**Problem:** The README shows save/restore *cost* (~787 ms save, ~579 ms restore) but not the *benefit* — dispatch latency with paging on vs `PI_LLAMA_SLOT_PAGING_DISABLED=1` at matched context sizes.

**What needs to happen:**
- Benchmark dispatch latency with slot save/restore active at 3+ context sizes (~20k, ~35k, ~50k tokens)
- Benchmark dispatch latency with `PI_LLAMA_SLOT_PAGING_DISABLED=1` at the same context sizes
- Compare the two: does restoring a cached KV state actually reduce dispatch latency vs. full re-encode?
- Update README with the comparison table

**Acceptance criteria:**
- At least 3 context sizes with both conditions (paging on vs disabled)
- Clear measurement of net dispatch latency difference
- Results documented in README

---

## 3. One Slot Per Subagent

**Priority:** Medium
**Status:** Not implemented

**Problem:** Currently all subagents share the `main` slot. This works for sequential dispatches but does not support parallel subagent execution. If two subagents are dispatched simultaneously, the save/restore cycle would interfere with each other.

**What needs to happen:**
- Assign a unique slot file per subagent dispatch
- Each subagent gets its own named slot (e.g., `subagent_0`, `subagent_1`, etc.)
- The main slot is only saved once at the start of the orchestrator loop
- Subagent slots are created on dispatch and cleaned up on completion

**Acceptance criteria:**
- Each subagent dispatch creates a unique slot
- Parallel subagents do not interfere with each other's slot state
- Main slot is preserved across subagent dispatches
- Subagent slots are cleaned up after completion

---

## 4. Slot Status Monitoring

**Priority:** Low
**Status:** Not implemented

**Problem:** The `active_subagent_count` field in `llama_slot_status` is a placeholder that always returns 0. There is no live tracking of subagent activity.

**What needs to happen:**
- Increment `active_subagent_count` when a subagent is dispatched
- Decrement when a subagent completes or fails
- Report accurate counts in the status tool

**Acceptance criteria:**
- `active_subagent_count` reflects the actual number of in-flight subagents
- Count increments on `Agent` tool call
- Count decrements on `tool_result` for subagent events
- Count never goes negative

---

## 5. Analyze Real Overhead

**Priority:** Medium
**Status:** Not started — requires live testing

**What needs to happen:**
- Run 3 sequential subagents
- Collect metrics from `pi-llama-slots.log`
- Verify save ~1-1.5s, restore ~0.6-1s on actual dispatches

**Acceptance criteria:**
- `wall_restore_slot_ms` is non-zero and in the expected range (0.6–1.0s on this hardware)
- Server timing and wall timing are within ~100ms of each other

---

## Completed Items

| # | Feature | Commit | Status |
|---|---------|--------|--------|
| — | Public GitHub repo + MIT license | `c387945` | ✅ |
| — | Metrics module (`src/metrics.ts`) | — | ✅ |
| — | Fixed `endRestoreSlot` bug | — | ✅ |
| — | API Key Support | `839cde7` | ✅ |
| — | Fail-First-Disable | — | ✅ |
| — | Model Change Tracking | `3fb0b34` | ✅ |
| — | README cleanup (tables, claims, redundancy) | `db6d9ce` | ✅ |
| — | Dynamic co-author in commit messages | — | ✅ |
