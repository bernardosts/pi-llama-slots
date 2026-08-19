# pi-llama-slot-paging — Implementation Plan

> **IMPORTANT: No changes are to be performed in this session.**
> All tasks below are to be delegated to a new pi session via `Agent` calls.
> This document is the single source of truth for what needs to be built.

---

## 1. Desired State

A pi extension that automatically manages llama-server slot save/restore for the orchestrator pattern, with:

- **Zero hardcoded values** — no default URLs, no default model names, no default paths
- **Runtime autodiscovery** — the extension derives everything from loaded runtime objects (`ctx.model`, `ctx.modelRegistry`)
- **No config files** — the extension uses `ctx.model` directly; no fallback config files
- **Simple lifecycle** — save main slot before subagent runs, restore after subagent completes. No parallelism. No subagent state persistence.

### What the extension does

1. On main session start/resume: detect the main session model and its llama-server endpoint
2. On `subagents:started`: save the main session's slot state to the `main` slot file
3. On `subagents:completed` or `subagents:failed`: restore the main session's slot state from the `main` slot file

### What the extension does NOT do

- Does NOT save/restore subagent state
- Does NOT handle parallel subagent execution
- Does NOT manage multiple slot files beyond `main`
- Does NOT have any hardcoded defaults

---

## 2. Verified Facts

### Session Events (from `types.d.ts`)

| Event | Fires on | `reason` values |
|-------|----------|-----------------|
| `session_start` | Session started, loaded, or reloaded | `"startup" \| "reload" \| "new" \| "resume" \| "fork"` |
| `session_shutdown` | Session torn down | `"quit" \| "reload" \| "new" \| "resume" \| "fork"` |
| `session_info_changed` | Session metadata changes | — |
| `session_before_switch` | Before switching sessions | `"new" \| "resume"` |
| `session_before_fork` | Before forking | — |
| `session_before_compact` | Before context compaction | — |
| `session_compact` | After context compaction | — |
| `session_before_tree` | Before tree navigation | — |
| `session_tree` | After tree navigation | — |

**No `session_resume` event exists.** Resumption is indicated by `session_start.reason === "resume"`.

### Subagent Events

**NOT in the typed API.** The extension uses `pi.events` (raw `EventBus`) which accepts arbitrary string channels. The following channels are used:

- `subagents:started` — when a subagent begins
- `subagents:completed` — when a subagent completes successfully
- `subagents:failed` — when a subagent fails/stops/aborts
- `subagents:compacted` — internal compaction within a subagent (ignored)
- `subagents:created` — before agent is running (ignored)

**These events are NOT emitted by pi-coding-agent core.** They must be emitted by the orchestrator pattern code that dispatches subagents. The extension only subscribes to them.

### Model Interface (from `@earendil-works/pi-ai/dist/types.d.ts`)

```typescript
interface Model<TApi extends Api> {
    id: string;           // e.g. "Qwen3.6-35B-Chat"
    name: string;
    api: TApi;
    provider: ProviderId;
    baseUrl: string;      // The llama-server endpoint
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: ModelCost;
    contextWindow: number;
    maxTokens: number;
    // ...
}
```

### Slot API (llama-server)

```
POST /slots/0?action=save
Body: { "model": "<model-id>", "filename": "<slot-name>" }
Response: { "id_slot": 0, "filename": "<slot-name>", "n_saved": 0, "n_written": <bytes>, "timings": { "save_ms": <ms> } }

POST /slots/0?action=restore
Body: { "model": "<model-id>", "filename": "<slot-name>" }
Response: { "id_slot": 0, "filename": "<slot-name>", "n_restored": 0, "n_read": <bytes>, "timings": { "restore_ms": <ms> } }
```

**Slot files are raw kv-cache bytes, NOT JSON.** The `filename` is just a session identifier (e.g., `main`).

### Extension Config Discovery

From `extensions.md`:
- Extensions can read project-local config from `.pi/<ext-name>.json`
- Extensions can read global config from `~/.pi/agent/<ext-name>.json`
- `CONFIG_DIR_NAME` is available from `@earendil-works/pi-coding-agent` for resolving config paths
- `ctx.isProjectTrusted()` should be called before reading project-local config

### Extension Context (`ctx`)

Available on event handlers:
- `ctx.model` — `Model<any> | undefined` — the active model
- `ctx.modelRegistry` — `ModelRegistry` — for provider/model lookups
- `ctx.cwd` — current working directory
- `ctx.ui` — UI primitives (notify, confirm, input, etc.)

### Available Typed Events (for `pi.on()`)

```
session_start, session_info_changed, session_before_switch, session_before_fork,
session_before_compact, session_compact, session_shutdown, session_before_tree,
session_tree, context, before_provider_request, before_provider_headers,
after_provider_response, before_agent_start, agent_start, agent_end,
agent_settled, turn_start, turn_end, message_start, message_update,
message_end, tool_execution_start, tool_execution_update, tool_execution_end,
model_select, thinking_level_select, tool_call, tool_result, user_bash, input
```

### Raw EventBus (`pi.events`)

```typescript
interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
```

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    pi Session                        │
│                                                      │
│  session_start (reason: "new"|"resume"|"startup")    │
│  ├── detect main model from ctx.model               │
│  ├── resolve llama-server URL from model.baseUrl    │
│  └── store in extension state                       │
│                                                      │
│  subagents:started  (raw EventBus channel)           │
│  ├── saveSlot(baseUrl, model.id, "main")            │
│                                                      │
│  subagents:completed / subagents:failed              │
│  └── restoreSlot(baseUrl, model.id, "main")         │
└─────────────────────────────────────────────────────┘
```

### Extension State

```typescript
interface SlotPagingState {
  baseUrl: string | null;
  modelId: string | null;
}
```

### Configuration (Runtime Autodiscovery Only)

```
1. On session_start, extract from ctx.model:
   - model.baseUrl → llama-server URL
   - model.id → slot model parameter
   - Strip /v1 suffix from baseUrl
   - If ctx.model is undefined → log error, skip slot management for this session
```

---

## 4. Files to Create/Modify

### Files to modify:

1. **`src/index.ts`** — Complete rewrite:
   - Remove hardcoded `DEFAULT_BACKEND_URL`
   - Remove hardcoded `"default"` model in slot operations
   - Use ctx.model directly for config (no config discovery helper needed)
   - Store `baseUrl` and `modelId` in extension state
   - Use `ctx.model.id` for slot operations
   - Subscribe to `session_start` for model detection
   - Keep `subagents:started`, `subagents:completed`, `subagents:failed` listeners on raw `pi.events`

2. **`src/slot-client.ts`** — Refactor:
   - Remove `DEFAULT_BACKEND_URL`
   - `resolveBackendUrl()` should accept `baseUrl` as parameter (not derive from env/config)
   - `saveSlot()` and `restoreSlot()` should accept `modelId` as parameter
   - Keep timeout at 120s

3. **`src/slot-status.ts`** — Minor update:
   - Update tool description to reflect new behavior
   - Remove references to automatic slot management driven by subagent lifecycle (keep as-is since it still is)

### Files to delete:

4. **`.env`** — Not needed (config is autodiscovered from `ctx.model`)
5. **`.pi/llama-slot-paging.json`** — Config file (no longer needed)

---

## 5. Task Breakdown (All to be delegated)

> **NO TASKS ARE TO BE PERFORMED IN THIS SESSION.**
> Each task below should be delegated to a new pi session.

### Task 1: Refactor `slot-client.ts`

**Goal:** Remove all hardcoded defaults. Make the slot client a pure HTTP wrapper.

- Remove `DEFAULT_BACKEND_URL` constant
- Remove `resolveBackendUrl()` function (no more env var fallback)
- `saveSlot(baseUrl, modelId, slotName)` — takes all parameters explicitly
- `restoreSlot(baseUrl, modelId, slotName)` — takes all parameters explicitly
- Keep `BACKEND_TIMEOUT = 120`
- Keep all types (`SlotSaveResult`, `SlotRestoreResult`)

### Task 2: ~~Implement config discovery helper~~ ~~(REMOVED — config.ts deleted)~~

~~The entire config discovery system has been removed. The extension now uses `ctx.model` directly.~~

### Task 3: Rewrite `src/index.ts`

**Goal:** Complete rewrite with proper lifecycle and state management.

- On `session_start`:
  - If `ctx.model` is available → use autodiscovery (model.id + model.baseUrl)
  - If `ctx.model` is NOT available → use config discovery helper
  - Store resolved `baseUrl` and `modelId` in extension state
  - Log the resolved config
- On `subagents:started` (raw EventBus):
  - If state is not initialized → log warning, skip
  - Call `saveSlot(baseUrl, modelId, "main")`
- On `subagents:completed` (raw EventBus):
  - Call `restoreSlot(baseUrl, modelId, "main")`
- On `subagents:failed` (raw EventBus):
  - Call `restoreSlot(baseUrl, modelId, "main")`
- Keep `llama_slot_status` tool (update to show resolved config)
- On `session_shutdown`:
  - Clean up event listeners
  - Clear state

### Task 4: Update `src/slot-status.ts`

**Goal:** Minor update to reflect new behavior.

- Update tool description to mention autodiscovery
- Update returned JSON to include resolved `model_id` and `base_url`
- Keep health check logic

### Task 5: ~~Create/update config files~~ ~~(REMOVED — no config files needed)~~

~~All config files have been removed. The extension uses runtime autodiscovery only.~~

### Task 6: Update `README.md`

**Goal:** Document the new architecture.

- Update "How It Works" section
- Update "Configuration" section (runtime autodiscovery only, add env var for explicit disable)
- Update "Files" section
- Remove "Config Discovery" section (no more config file fallback)

---

## 6. Open Questions

These need to be answered before implementation:

1. **Do the `subagents:*` events actually fire?** — The orchestrator code that dispatches subagents must emit these events on `pi.events`. If they don't fire, the extension won't trigger slot save/restore. This needs verification in the orchestrator code.

2. **What happens on `session_start` when `ctx.model` is undefined?** — The extension should handle this gracefully. Options:
   - Wait for a later event that has `ctx.model`
   - Use config file fallback
   - Log error and skip slot management for this session

3. **Should the extension handle `session_shutdown` reason="resume" specially?** — When a session is resumed, the old session's shutdown fires before the new session's start. The extension should clean up state on shutdown and re-initialize on the new session start.

4. **What if the llama-server URL changes between sessions?** — The extension re-resolves on each `session_start`, so this should be handled naturally.

---

## 7. Testing Strategy

For each task, testing should verify:

1. **slot-client.ts:** HTTP calls to llama-server with correct model ID and slot name
2. **Config discovery:** Autodiscovery works when `ctx.model` is available; fallback works when it's not
3. **Lifecycle:** Save fires on `subagents:started`, restore fires on `subagents:completed`/`subagents:failed`
4. **No parallelism bugs:** Only one save/restore pair per subagent cycle
5. **Error handling:** Extension logs errors but doesn't crash when slot operations fail
