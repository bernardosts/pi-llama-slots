# NEXT_ITEMS.md — Pending Work

## 1. Non-llama Endpoint Detection

**Priority:** High  
**Status:** Not implemented

**Problem:** When the extension connects to a backend that does not support the llama slots API, it fails on every save/restore attempt. There is no graceful degradation — the extension keeps trying and showing errors.

**What needs to happen:**
- On extension init, probe the backend to check if it supports the llama slots API (e.g., call a slots endpoint and check the response)
- If the backend is not llama-compatible, disable the extension for the remainder of the session
- Show a clear TUI message explaining why the extension was disabled
- Do not attempt any save/restore calls for the rest of the session

**Acceptance criteria:**
- Extension detects non-llama backend on startup
- Extension logs a clear message: "llama slots API not available, disabling"
- No save/restore attempts are made for the rest of the session
- No TUI warnings are shown for save/restore failures

---

## 2. Model Change Tracking

**Priority:** High  
**Status:** Not implemented

**Problem:** Slot state is model-specific. If the model used by the main session changes during a session, the cached KV state in the slot is invalid for the new model. This can cause crashes or silent corruption.

**What needs to happen:**
- Track the model ID used when the slot was last saved
- On each save/restore cycle, compare the current model with the saved model
- If the model has changed:
  - Detect the mismatch
  - Show a TUI warning explaining the model change
  - Either: (a) refuse to restore and clear the slot, or (b) auto-clear the slot and warn the user
  - Do not attempt to restore stale model-specific state

**Acceptance criteria:**
- Extension tracks `model_id` alongside slot state
- Model mismatch is detected before restore
- User is notified via TUI when a model change is detected
- No restore is attempted with a mismatched model
- Session remains stable after a model change

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

## 5. Pruning / LRU Eviction

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
