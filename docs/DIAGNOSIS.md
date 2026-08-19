# Slot Save/Restore Diagnosis

## Test Methodology

1. Dispatched a subagent using `unsloth/Qwen3.5-4B-GGUF:Q4_0` model (different from main 35B model)
2. Captured the full llama-server router log during the model switch
3. Directly tested the slot save/restore API with curl to verify it works

## Timeline of Events (from server.log)

### Phase 1: Main Conversation (35B Model)
```
Timestamp 12.14  | Task 989  (35B) | stop processing: n_tokens = 36357
Timestamp 13.20  | Task 1396 (35B) | LCP sim=0.139, f_keep=0.021 | stop processing: n_tokens = 5840
```

### Phase 2: Model Switch (35B → 4B) — THE PROBLEM ZONE
```
Timestamp 13.28  | Router: evicting idle LRU name=unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS to make room for name=unsloth/Qwen3.5-4B-GGUF:Q4_0
Timestamp 13.28  | Router: unload: stopping model instance name=unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS
Timestamp 13.28  | Router: evicting idle LRU (again) — 35B already gone
Timestamp 13.28  | Router: unload: stopping model instance (again) — 35B already gone
```

### Phase 3: 4B Model Runs
```
Timestamp 13.41  | Router: proxying request to model unsloth/Qwen3.5-4B-GGUF:Q4_0 on port 44073
Timestamp 13.41  | Slot: selected by LRU, t_last = -1 (FRESH slot)
Timestamp 13.41  | Task 0 (4B): prompt=25 tokens, decoded=50 tokens
Timestamp 13.41  | Task 1 (4B): prompt=23 tokens, decoded=50 tokens
```

### Phase 4: Model Switch (4B → 35B)
```
Timestamp 13.55  | Router: evicting idle LRU name=unsloth/Qwen3.5-4B-GGUF:Q4_0 to make room for name=unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS
Timestamp 13.55  | Router: unload: stopping model instance name=unsloth/Qwen3.5-4B-GGUF:Q4_0
```

### Phase 5: 35B Reloads
```
Timestamp 14.24  | Router: proxying request to model unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS on port 38617
Timestamp 14.24  | Slot: selected by LRU, t_last = -1 (FRESH slot — no restore!)
Timestamp 14.24  | Task 0 (35B): prompt=6505 tokens, decoded=605 tokens
```

### Phase 6: 35B Continuation
```
Timestamp 15.31  | Slot: selected by LCP similarity, f_sim_best = 0.985, f_keep = 1.000
Timestamp 15.31  | Task 248 (35B): prompt=552 tokens, decoded=225 tokens
```

## Critical Findings

### Finding 1: NO slot_save before 35B eviction

**Expected:** Before the 35B model is evicted, the extension should call `POST /slots/0?action=save` with `{"model": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS", "filename": "main"}`.

**Actual:** No `slot_save`, `save_slot`, `llama_state`, or any slot save operation appears anywhere in the log between Task 1396 stopping (13.20) and the 35B model being evicted (13.28).

The KV cache of the 35B model is **completely lost** when the model is unloaded.

### Finding 2: NO slot_restore after 35B reload

**Expected:** After the 35B model reloads, the extension should call `POST /slots/0?action=restore` with `{"model": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS", "filename": "main"}`.

**Actual:** No `slot_restore`, `restore_slot`, `state_read`, or any slot restore operation appears in the log. The 35B model loads on a fresh slot (LRU, t_last=-1).

### Finding 3: LCP similarity after reload is misleading

After the 35B model reloads, the LCP similarity shows 0.985 with f_keep=1.000. This appears to be a **false positive** — the LCP is matching against the 4B model's KV cache (which was just in the slot), not against a saved state. Since the models are different, this match is meaningless for the 35B model's actual KV cache.

### Finding 4: Slot save/restore API works when called directly

```
$ curl -s http://127.0.0.1:8080/slots/0?action=save -X POST -d '{"model":"...","filename":"test-save"}'
{"id_slot":0,"filename":"test-save","n_saved":47511,"n_written":1040030232,"timings":{"save_ms":273.645}}

$ curl -s http://127.0.0.1:8080/slots/0?action=restore -X POST -d '{"model":"...","filename":"test-save"}'
{"id_slot":0,"filename":"test-save","n_restored":47511,"n_read":1040030232,"timings":{"restore_ms":670.551}}
```

The API works perfectly. The issue is that **the extension is not calling it**.

## Root Cause Analysis

The extension code (`src/index.ts`) has the correct logic:
- `session_start` → `handleSaveMainSlot()` → `saveSlot(baseUrl, modelId, "main")`
- `subagents:completed` → `handleRestoreMainSlot()` → `waitForModelLoaded()` → `restoreSlot(baseUrl, modelId, "main")`
- `subagents:failed` → `handleRestoreMainSlot()` → same as above

But the API calls are **not reaching the server**. Possible causes:

### Cause A: Extension not loaded in this session
The extension is loaded from the project directory (`/home/bernardo/MEGA/Projetos/Outros/pi-llama-slots/`), but it may not be registered/trusted for the current session. The `trust.json` does not include this path.

### Cause B: Events not firing
The `subagents:completed` and `subagents:failed` events from `@tintinweb/pi-subagents` may not be firing, or the extension's event listeners are not attached correctly.

### Cause C: API calls failing silently
The extension wraps API calls in try/catch blocks that log errors but don't rethrow them. If the calls fail (network error, wrong URL, etc.), the error is caught and logged to console, but the extension continues silently.

### Cause D: Model ID mismatch
The extension uses `ctx.model?.id` to get the model ID. If this doesn't match the model ID used by the router (e.g., `unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS` vs a different format), the save/restore calls would target the wrong model and fail.

## Recommended Investigation Steps

1. **Check extension loading**: Add a console.log at the very start of the extension's `session_start` handler to verify it fires.

2. **Check API call responses**: Modify the extension to log the full response from the slot save/restore API calls, not just errors.

3. **Check model ID resolution**: Log the exact `modelId` and `baseUrl` values resolved by the extension.

4. **Check event firing**: Add console.log in the `subagents:completed` and `subagents:failed` handlers.

5. **Check trust configuration**: Ensure the extension path is in `trust.json`.

## Correct Flow (What Should Happen)

```
1. Main model (35B) finishes Task 1396
   └─> slot is idle, 35B still loaded
   
2. Extension detects subagent starting
   └─> POST /slots/0?action=save {model: "35B", filename: "main"}
       └─> KV cache saved to /home/bernardo/llama-slots/main  ← MISSING
   
3. Router detects 4B model request
   └─> evict 35B (idle LRU)
   └─> unload 35B
   
4. 4B model loads on slot 0
   └─> fresh slot, no KV cache
   
5. Subagent runs on 4B
   
6. Subagent finishes
   └─> subagents:completed event fires
   
7. Extension detects model switch back
   └─> waitForModelLoaded("35B")
   └─> POST /slots/0?action=restore {model: "35B", filename: "main"}
       └─> KV cache restored from /home/bernardo/llama-slots/main  ← MISSING
       
8. 35B continues with saved KV cache
```

## Current Flow (What Actually Happens)

```
1. Main model (35B) finishes Task 1396
   └─> slot is idle, 35B still loaded
   
2. Router detects 4B model request (extension did nothing)
   └─> evict 35B (idle LRU)
   └─> unload 35B  ← KV cache LOST
   
3. 4B model loads on slot 0
   └─> fresh slot
   
4. Subagent runs on 4B
   
5. Subagent finishes
   
6. Router detects 35B model request
   └─> evict 4B
   └─> unload 4B
   └─> load 35B
   
7. 35B loads on fresh slot (no restore happened)
   └─> LCP similarity 0.985 is FALSE POSITIVE (matching 4B's KV cache, not 35B's)
   
8. 35B continues from scratch (no KV cache)
```
