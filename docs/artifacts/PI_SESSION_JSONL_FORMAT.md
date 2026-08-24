# Pi Session JSONL Format

Exported session data from pi (pi-coding-agent) is written as a **JSON Lines** file — one JSON object per line. Each line represents a single event in the session lifecycle.

---

## Line Types

| `type` | Description | Occurrence |
|--------|-------------|------------|
| `session` | Session header — metadata about the session | Exactly once, always first line |
| `model_change` | Model/provider change event | Once per session (on startup) |
| `thinking_level_change` | User-adjusted thinking level | Once per session (on startup) |
| `message` | LLM conversation turn (user, assistant, tool result) | Many — one per LLM interaction |
| `custom` | Custom event (e.g. subagent lifecycle) | Variable |

---

## Line Type Schemas

### 1. `session` — Session Header

Session metadata. Always the first line.

```json
{
  "type": "session",
  "version": 3,
  "id": "01a025f3-0f38-7116-a3c2-f7194e5ad020",
  "timestamp": "2026-08-21T20:11:21.272Z",
  "cwd": "/home/bernardo/MEGA/Projetos/Outros/pi-llama-slots"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"session"` |
| `version` | integer | Format version (currently `3`) |
| `id` | string | UUID of the session |
| `timestamp` | string | ISO 8601 timestamp of session creation |
| `cwd` | string | Working directory at session start |

---

### 2. `model_change` — Model/Provider Change

Records the active model and provider.

```json
{
  "type": "model_change",
  "id": "898ffc0b",
  "parentId": null,
  "timestamp": "2026-08-21T20:11:22.116Z",
  "provider": "llama-sycl",
  "modelId": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"model_change"` |
| `id` | string | Short hex identifier |
| `parentId` | string\|null | Parent event ID (usually `null`) |
| `timestamp` | string | ISO 8601 timestamp |
| `provider` | string | Provider identifier (e.g. `"llama-sycl"`, `"openai"`) |
| `modelId` | string | Model identifier string |

---

### 3. `thinking_level_change` — Thinking Level

Records the active thinking/reasoning level.

```json
{
  "type": "thinking_level_change",
  "id": "2bc4cf64",
  "parentId": "898ffc0b",
  "timestamp": "2026-08-21T20:11:22.116Z",
  "thinkingLevel": "medium"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"thinking_level_change"` |
| `id` | string | Short hex identifier |
| `parentId` | string | Parent event ID (references `model_change.id`) |
| `timestamp` | string | ISO 8601 timestamp |
| `thinkingLevel` | string | One of: `"off"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |

---

### 4. `message` — Conversation Turn

The core event type. Each line represents one message in the conversation. The `message` field contains the actual message payload.

#### 4a. Assistant Message (`role: "assistant"`)

```json
{
  "type": "message",
  "id": "c02dd766",
  "parentId": "21d27a40",
  "timestamp": "2026-08-21T20:17:27.699Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants me to...",
        "thinkingSignature": "reasoning_content"
      },
      {
        "type": "text",
        "text": "Looking at this test scenario..."
      },
      {
        "type": "toolCall",
        "id": "SHsRpenGEIyz1i1QWvZBaLRzIYncjWgK",
        "name": "bash",
        "arguments": "{\"command\":\"echo hello\"}"
      },
      {
        "type": "toolCall",
        "id": "xeXt0B2m0AK3ef6sSlYezJCsdPxrQ0Zu",
        "name": "read",
        "arguments": "{\"path\":\"/path/to/file.md\"}"
      }
    ],
    "stopReason": "toolUse",
    "rawStopReason": "tool_calls",
    "usage": {
      "input": 9955,
      "output": 4326,
      "cacheRead": 0,
      "cacheWrite": 0,
      "reasoning": 0,
      "totalTokens": 14281,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "api": "openai-completions",
    "provider": "llama-sycl",
    "model": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:IQ4_XS",
    "responseId": "chatcmpl-RPzPRy8Iw1ZRjt4b24r66by2GhIti8jv",
    "timestamp": 1787343082193
  }
}
```

**Line-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"message"` |
| `id` | string | Short hex identifier for this message |
| `parentId` | string | ID of the parent message (the user message this is responding to) |
| `timestamp` | string | ISO 8601 timestamp of the message event |

**`message` object fields:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | Always `"assistant"` |
| `content` | array | Array of content parts (see [Content Types](#content-types)) |
| `stopReason` | string | High-level stop reason: `"toolUse"` or `"endTurn"` |
| `rawStopReason` | string | Raw stop reason from the model: `"tool_calls"`, `"stop"`, `"length"`, etc. |
| `usage` | object | Token usage metrics (see [Usage Object](#usage-object)) |
| `api` | string | API format used (e.g. `"openai-completions"`) |
| `provider` | string | Provider identifier |
| `model` | string | Model identifier |
| `responseId` | string | Provider-specific response ID |
| `timestamp` | integer | Unix millisecond timestamp (numeric, not ISO string) |

---

#### 4b. User Message (`role: "user"`)

```json
{
  "type": "message",
  "id": "21d27a40",
  "parentId": "2bc4cf64",
  "timestamp": "2026-08-21T20:11:22.149Z",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "<file name=\"...\">\n# Test Scenario...\n</file>\nRun this test scenario..."
      }
    ]
  }
}
```

**`message` object fields:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | Always `"user"` |
| `content` | array | Array of content parts (see [Content Types](#content-types)) |

---

#### 4c. Tool Result Message (`role: "toolResult"`)

```json
{
  "type": "message",
  "id": "72e4ec57",
  "parentId": "c02dd766",
  "timestamp": "2026-08-21T20:17:27.725Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "SHsRpenGEIyz1i1QWvZBaLRzIYncjWgK",
    "toolName": "bash",
    "content": [
      {
        "type": "text",
        "text": "=== Environment Check ===\nPI_LLAMA_SLOT_PAGING_DISABLED=1\n..."
      }
    ],
    "isError": false
  }
}
```

**`message` object fields:**

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | Always `"toolResult"` |
| `toolCallId` | string | ID referencing the `toolCall` in the assistant message |
| `toolName` | string | Name of the tool that was called (e.g. `"bash"`, `"read"`, `"Agent"`) |
| `content` | array | Array of content parts (see [Content Types](#content-types)) |
| `isError` | boolean | Whether the tool call resulted in an error |

**Extended toolResult (Agent tool):** When the `toolName` is `"Agent"`, the message may include a `details` field:

```json
{
  "role": "toolResult",
  "toolCallId": "...",
  "toolName": "Agent",
  "content": [...],
  "isError": false,
  "details": {
    "displayName": "Agent",
    "description": "Research Moser spindle graph",
    "subagentType": "general-purpose",
    "tags": ["twin"],
    "toolUses": 2,
    "tokens": "16.4k token",
    "turnCount": 3,
    "durationMs": 133587,
    "status": "completed",
    "agentId": "defef103-1618-4eb"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `details` | object | Extended metadata about the subagent run (only on `toolName: "Agent"`) |

---

### 5. `custom` — Custom Event

Arbitrary custom events, typically used by extensions or the orchestrator for lifecycle tracking.

```json
{
  "type": "custom",
  "customType": "subagents:record",
  "data": {
    "id": "bde3db23-cc81-4f3",
    "type": "general-purpose",
    "description": "Research Moser spindle graph",
    "status": "completed",
    "result": "## Moser Spindle — Summary...",
    "startedAt": 1787343576156,
    "completedAt": 1787343706583
  },
  "id": "59f6ba26",
  "parentId": "5b98cc43",
  "timestamp": "2026-08-21T20:21:46.583Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"custom"` |
| `customType` | string | Event channel identifier (e.g. `"subagents:record"`) |
| `data` | object | Arbitrary payload — structure depends on `customType` |
| `id` | string | Short hex identifier |
| `parentId` | string | Parent message ID |
| `timestamp` | string | ISO 8601 timestamp |

---

## Content Types

Content within a `message.content` array can be one of the following types:

### `text`

Plain text content.

```json
{
  "type": "text",
  "text": "Hello world"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"text"` |
| `text` | string | The text content |

### `thinking`

Reasoning/thinking content (when thinking is enabled).

```json
{
  "type": "thinking",
  "thinking": "Let me analyze this step by step...",
  "thinkingSignature": "reasoning_content"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"thinking"` |
| `thinking` | string | The thinking/reasoning text |
| `thinkingSignature` | string | Signature method used (e.g. `"reasoning_content"`) |

### `toolCall`

A tool call made by the assistant.

```json
{
  "type": "toolCall",
  "id": "SHsRpenGEIyz1i1QWvZBaLRzIYncjWgK",
  "name": "bash",
  "arguments": "{\"command\":\"echo hello\"}"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Literal `"toolCall"` |
| `id` | string | Unique tool call ID (referenced by `toolResult.toolCallId`) |
| `name` | string | Tool name (e.g. `"bash"`, `"read"`, `"Agent"`) |
| `arguments` | string | JSON-encoded arguments string |

---

## Usage Object

Present on assistant messages. Contains token usage and cost metrics.

```json
{
  "input": 9955,
  "output": 4326,
  "cacheRead": 0,
  "cacheWrite": 0,
  "reasoning": 0,
  "totalTokens": 14281,
  "cost": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "total": 0
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `input` | integer | Input tokens consumed |
| `output` | integer | Output tokens generated |
| `cacheRead` | integer | Tokens read from KV cache (slot restore hit) |
| `cacheWrite` | integer | Tokens written to KV cache |
| `reasoning` | integer | Tokens used for reasoning/thinking |
| `totalTokens` | integer | Total tokens (`input + output`) |
| `cost` | object | Cost breakdown (all zero for local providers) |
| `cost.input` | number | Cost for input tokens |
| `cost.output` | number | Cost for output tokens |
| `cost.cacheRead` | number | Cost for cache read tokens |
| `cost.cacheWrite` | number | Cost for cache write tokens |
| `cost.total` | number | Total cost |

---

## Message Hierarchy

Messages form a tree via `id`/`parentId` references:

```
session (id: implicit)
├── model_change (id: 898ffc0b)
│   └── thinking_level_change (parentId: 898ffc0b)
│       └── message (user, id: 21d27a40, parentId: 2bc4cf64)
│           └── message (assistant, id: c02dd766, parentId: 21d27a40)
│               ├── message (toolResult, id: 72e4ec57, parentId: c02dd766)
│               ├── message (toolResult, id: 22add7fd, parentId: 72e4ec57)
│               └── message (toolResult, id: ad078b1a, parentId: 22add7fd)
│                   └── message (assistant, id: 7786cb4d, parentId: ad078b1a)
```

- `parentId` references the message that triggered this one
- Multiple tool results from the same assistant turn chain sequentially (each tool result's `parentId` is the previous tool result or the assistant message)
- The next assistant message's `parentId` is the last tool result in the chain

---

## Timestamps

Two timestamp formats are used:

| Location | Format | Example | Description |
|----------|--------|---------|-------------|
| Line-level `timestamp` | ISO 8601 | `"2026-08-21T20:17:27.699Z"` | Human-readable, millisecond precision |
| Assistant `message.timestamp` | Unix ms | `1787343082193` | Numeric, millisecond epoch |

---

## Complete Event Flow Example

A typical LLM turn with tool calls:

```
1. user sends message          → message (role: user)
2. assistant responds w/ tools → message (role: assistant) with toolCall content parts
3. tool results returned        → message (role: toolResult) × N
4. assistant responds again     → message (role: assistant) with next response
5. (repeat 2-4 until done)
6. final assistant response     → message (role: assistant) with stopReason: "endTurn"
```

A subagent dispatch adds custom events:

```
1. assistant dispatches agent   → message (role: assistant) with toolCall (name: "Agent")
2. custom subagent record       → custom (customType: "subagents:record")
3. tool result returns          → message (role: toolResult) with toolName: "Agent"
4. assistant continues          → message (role: assistant)
```
