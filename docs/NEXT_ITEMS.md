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
**Status:** Not implemented

**Problem:** If llama-server is started with `--api-key`, all slot save/restore HTTP calls fail with 401/403. The extension does not read or forward API keys from any source — pi's model config (`models.json`), environment variables, or any other mechanism.

The extension currently makes raw `fetch()` calls with only `Content-Type: application/json` headers. No `Authorization` header is ever sent.

**What needs to happen:**
- Detect whether llama-server requires authentication (probe with a request and check for 401/403)
- Read the API key from a configurable source (environment variable, pi config, or llama-server config)
- Forward the API key as `Authorization: Bearer <key>` on all requests to llama-server
- Gracefully degrade if the key is unavailable (same as non-llama detection)

**Acceptance criteria:**
- Extension sends `Authorization: Bearer <key>` on all llama-server requests when a key is configured
- Extension detects when llama-server requires auth and fails gracefully if no key is available
- API key source is configurable (env var `PI_LLAMA_SLOT_PAGING_API_KEY` or similar)
- No API key is logged or leaked in log files

---

## 2. Non-llama Endpoint Detection

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
