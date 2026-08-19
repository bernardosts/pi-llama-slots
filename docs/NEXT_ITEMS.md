# NEXT_ITEMS.md — Pending Work

## 1. Double-check Metrics

**Priority:** Medium (just verify)
**Status:** In progress — pending current subagent to complete

**What needs to happen:**
- After the current subagent completes, verify the metrics log has correct `wall_restore_slot_ms` values (non-zero)
- Quick check: `grep "^\\[METRICS\\]" pi-llama-slots.log | tail -5`

**Acceptance criteria:**
- `wall_restore_slot_ms` is non-zero and in the expected range (0.6–1.0s on this hardware)
- Server timing and wall timing are within ~100ms of each other

---

## 2. API Key Support

**Priority:** High  
**Status:** ✅ Implemented in `839cde7`

**Implemented:**
- `PI_LLAMA_SLOT_PAGING_API_KEY` env var → `Authorization: Bearer <key>` on all fetch calls
- Auth probe on first save/restore: detects 401/403 → graceful session disable
- API key never logged (only presence/length in debug logs)
- Status tool forwards key for health check

---

## 3. Non-llama Endpoint Detection

**Priority:** High  
**Status:** ✅ Implemented in `923f28e`

**Implemented:**
- Backend probe on `session_start`: `GET /v1/models` + `POST /slots/0?action=save` (2s timeout)
- Graceful session disable if slots API not available
- TUI warning + clear log message on disable
- Status tool reports `slotsProbeResult` field
- Network errors skip probe (no false disable)

---

## 4. Model Change Tracking

**Priority:** High  
**Status:** ✅ Implemented in `3fb0b34`

**Implemented:**
- Tracks `lastSavedModelId` alongside slot state
- Refuses restore on model mismatch → TUI warning, fresh slot used
- Skips restore if `lastSavedModelId` is null (no prior save)
- Resets on `session_start` (new session, stale slot file)
- Status tool reports `last_saved_model` field

---

## 5. One Slot Per Subagent

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

## 6. Pruning / LRU Eviction

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
