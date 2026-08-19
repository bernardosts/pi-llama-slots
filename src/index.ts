/**
 * llama-slot-paging — Automatic slot save/restore driven by subagent lifecycle
 *
 * Configuration is resolved via runtime autodiscovery from ctx.model.
 *
 * Lifecycle:
 *   session_start (main)    → detect model, set mainSessionModelId
 *   tool_call (subagent)    → saveSlot(baseUrl, modelId, "main")
 *   tool_result (subagent)  → restoreSlot(baseUrl, modelId, "main")
 *   session_shutdown        → clean up state and listeners
 *
 * Manual tools:
 *   - llama_slot_status : query backend connectivity (debugging)
 *
 * NOTE: We listen to the `tool_call` event to detect when the `subagent` tool
 * is invoked. At this point, the main session's model is still loaded in the
 * slot (the router hasn't switched to the subagent model yet). We save the
 * slot here, then on `tool_result` (after the subagent completes and the main
 * model reloads), we restore the saved slot.
 */

import * as fs from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { saveSlot, restoreSlot, loadModel, waitForModelLoadedExplicit, isModelLoaded } from "./slot-client.js";
import { createStatusTool } from "./slot-status.js";
import { createMetrics } from "./metrics.js";

// ---- Debug Logging ----

const LOG_FILE = "./pi-llama-slots.log";

/** Whether debug logging is enabled. Disabled by default; set PI_LLAMA_SLOT_PAGING_LOGGING=1 to enable. */
const LOGGING_ENABLED =
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "1" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "true" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "yes";

function idxLog(tag: string, ...args: unknown[]): void {
  if (!LOGGING_ENABLED) return;
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${tag}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
  }
}

function idxInfo(...args: unknown[]): void {
  idxLog("INFO", ...args);
}

function idxWarn(...args: unknown[]): void {
  idxLog("WARN", ...args);
}

function idxErr(...args: unknown[]): void {
  idxLog("ERR", ...args);
}

/** Show a TUI warning notification. Falls back to console if ctx is not available. */
let showWarning: (message: string) => void = () => {};

function setWarningContext(notify: (message: string, type?: "warning" | "error") => void) {
  showWarning = (message: string) => {
    notify(`[llama-slot-paging] ⚠️ ${message}`, "warning");
  };
}

// ---- Extension State ----

interface SlotPagingState {
  baseUrl: string | null;
  modelId: string | null;
  sessionDisabled: boolean;
  /** True once we have confirmed auth is not required (or not configured). */
  authProbeDone: boolean;
}

export default function (pi: ExtensionAPI) {

  // Check for explicit disable via environment variable
  const isDisabled =
    process.env.PI_LLAMA_SLOT_PAGING_DISABLED === "1" ||
    process.env.PI_LLAMA_SLOT_PAGING_DISABLED === "true" ||
    process.env.PI_LLAMA_SLOT_PAGING_DISABLED === "yes";
  if (isDisabled) {
    return; // Exit early, no listeners registered
  }

  // ---- State ----

  /** Resolved configuration for the current session. */
  const state: SlotPagingState = {
    baseUrl: null,
    modelId: null,
    sessionDisabled: false,
    authProbeDone: false,
  };

  // ---- API Key Configuration ----

  /** API key read from environment. Empty string or undefined means no key. */
  const apiKey: string | undefined = process.env.PI_LLAMA_SLOT_PAGING_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    idxInfo("API key configured (length=" + apiKey.length + "), will send Authorization header");
  } else {
    idxInfo("No API key configured (PI_LLAMA_SLOT_PAGING_API_KEY not set or empty)");
  }

  /** The main session model ID, set once on first session_start. */
  let mainSessionModelId: string | null = null;

  /** Registered unsubscribe functions, cleaned up on session_shutdown. */
  const cleanupFns: Array<() => void> = [];

  /** Number of currently active subagents. */
  let activeSubagentCount = 0;

  /** Metrics collector — null when logging is disabled. */
  const metrics = createMetrics();

  // ---- Slot management helpers ----

  /**
   * Handle save with auth failure detection.
   * On first call (auth_probe), detect 401/403 and set authProbeDone.
   * If auth required but no key → disable for session.
   */
  async function handleSaveMainSlot(): Promise<void> {
    idxInfo("handleSaveMainSlot START", { baseUrl: state.baseUrl, modelId: state.modelId });
    if (!state.baseUrl || !state.modelId) {
      idxErr("Cannot save: baseUrl or modelId not resolved.", { baseUrl: state.baseUrl, modelId: state.modelId });
      return;
    }
    metrics?.startSave(state.modelId);
    try {
      idxInfo("Calling saveSlot", { baseUrl: state.baseUrl, modelId: state.modelId, slotName: "main", hasApiKey: !!apiKey });
      const result = await saveSlot(state.baseUrl, state.modelId, "main", apiKey);
      idxInfo("saveSlot SUCCESS", result);
      metrics?.endSave(result);

      // Auth probe: if this is the first call and we got 401/403, detect it
      if (!state.authProbeDone) {
        state.authProbeDone = true;
        // 401/403 would have thrown above — no further action needed on success
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Auth failure detection: 401 or 403 with no key configured
      const authMismatch = (msg.includes("HTTP 401") || msg.includes("HTTP 403")) && apiKey === undefined;

      if (authMismatch) {
        idxWarn("Auth failure detected: llama-server appears to require API key but none configured. Disabling for session.");
        showWarning(
          "llama-server appears to require an API key (401/403), but PI_LLAMA_SLOT_PAGING_API_KEY is not configured. " +
          "Slot save/restore has been disabled for this session. Configure the key or start llama-server without --api-key.",
        );
        state.sessionDisabled = true;
        state.authProbeDone = true;
      } else {
        idxErr("Error saving main slot:", msg);
        showWarning(`Failed to save main slot: ${msg}`);
        state.sessionDisabled = true;
      }
      metrics?.endSave(null, msg);
    }
  }

  /**
   * Restore the main slot.
   *
   * New strategy: explicitly load the main model via /models/load, wait for
   * it to finish loading, then restore the slot while the model is idle.
   * This avoids the race condition where tool_result fires and the main
   * session has already started processing (which would corrupt the KV cache).
   *
   * Sequence:
   *   1. POST /models/load {"model": "<mainModelId>"}
   *   2. Poll /v1/models until status = "loaded"
   *   3. POST /slots/0?action=restore (model is idle, no race)
   */
  async function handleRestoreMainSlot(): Promise<void> {
    idxInfo("handleRestoreMainSlot START", { sessionDisabled: state.sessionDisabled, baseUrl: state.baseUrl, modelId: state.modelId });
    if (state.sessionDisabled) {
      idxInfo("handleRestoreMainSlot SKIPPED (sessionDisabled)");
      return;
    }
    if (!state.baseUrl || !state.modelId) {
      idxErr("Cannot restore: baseUrl or modelId not resolved.", { baseUrl: state.baseUrl, modelId: state.modelId });
      return;
    }
    metrics?.startRestore(state.modelId);
    let slotRestoreStart = 0; // wall-clock start of slot restore phase
    try {
      // Step 1: Explicitly load the main model via /models/load
      idxInfo("Step 1: Loading main model via /models/load...", state.modelId);
      const t0 = Date.now();
      let loadSucceeded = false;
      try {
        await loadModel(state.baseUrl, state.modelId, apiKey);
        metrics?.endRestoreModelLoad(Date.now() - t0);
        loadSucceeded = true;
        idxInfo("Step 1: /models/load request sent, waiting for model to finish loading...", state.modelId);

        // Step 2: Wait for the model to reach "loaded" status
        const t1 = Date.now();
        await waitForModelLoadedExplicit(state.baseUrl, state.modelId, undefined, undefined, apiKey);
        metrics?.endRestoreWait(Date.now() - t1);
        idxInfo("Step 2: Model is loaded — proceeding with restore.", state.modelId);
      } catch (loadError) {
        const loadMsg = loadError instanceof Error ? loadError.message : String(loadError);
        if (loadMsg.includes("already running") || loadMsg.includes("already loaded")) {
          idxInfo("Step 1: Model already running — skipping load, proceeding to restore.", state.modelId);
        } else {
          idxErr("Step 1: loadModel failed (non-recoverable):", loadMsg);
          showWarning(`Failed to load main slot: ${loadMsg}`);
          state.sessionDisabled = true;
          metrics?.endRestoreSlot(0);
          return;
        }
      }

      // Step 3: Restore the slot while the model is idle (no main session processing yet)
      slotRestoreStart = Date.now();
      idxInfo("Step 3: Restoring slot...", state.modelId);
      const result = await restoreSlot(state.baseUrl, state.modelId, "main", apiKey);
      idxInfo("restoreSlot SUCCESS", result);
      metrics?.endRestoreSlot(Date.now() - slotRestoreStart, result as unknown as Record<string, unknown>);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Auth failure detection on restore
      const authMismatch = (msg.includes("HTTP 401") || msg.includes("HTTP 403")) && apiKey === undefined;

      if (authMismatch) {
        idxWarn("Auth failure on restore: llama-server appears to require API key but none configured. Disabling for session.");
        showWarning(
          "llama-server appears to require an API key (401/403), but PI_LLAMA_SLOT_PAGING_API_KEY is not configured. " +
          "Slot save/restore has been disabled for this session. Configure the key or start llama-server without --api-key.",
        );
        state.sessionDisabled = true;
        state.authProbeDone = true;
      } else {
        idxErr("Error restoring main slot:", msg);
        showWarning(`Failed to restore main slot: ${msg}`);
        state.sessionDisabled = true;
      }
      metrics?.endRestoreSlot(slotRestoreStart > 0 ? Date.now() - slotRestoreStart : 0);
    }
  }

  // ---- Register tools ----

  // llama_slot_status tool
  pi.registerTool(
    createStatusTool(
      () => state.baseUrl ?? "",
      () => activeSubagentCount,
      () => state.modelId,
      () => state.baseUrl,
      () => apiKey,
    ),
  );

  // ---- Session lifecycle ----

  /** Main session reasons: these indicate the orchestrator session, not a subagent. */
  const MAIN_SESSION_REASONS: Set<string> = new Set(["startup", "resume", "reload"]);



  pi.on("session_start", async (_event, ctx) => {
    idxInfo("session_start event", { reason: _event.reason });
    const isMainSession = MAIN_SESSION_REASONS.has(_event.reason);

    if (!isMainSession) {
      // Subagent session — skip. Subagent sessions have their own event bus
      // and the subagent lifecycle events only fire on the main session's bus.
      idxInfo("session_start SKIPPED (not main session, reason=", _event.reason, ")");
      return;
    }

    const modelId = ctx.model?.id;
    const baseUrl = ctx.model?.baseUrl?.replace(/\/v1(\/?$)/, "") ?? "";

    idxInfo("session_start resolved", { modelId, baseUrl });

    if (modelId && baseUrl) {
      idxInfo("Main session started — model:", modelId);

      // Reset state for new session
      state.baseUrl = baseUrl;
      state.modelId = modelId;
      state.sessionDisabled = false;

      // Set up TUI warning context for this session
      setWarningContext(ctx.ui.notify.bind(ctx.ui));

      // Record the main session model ID on first session_start.
      // This is the model that will be loaded in the slot when the main
      // session is active. We don't save the slot here because the router
      // may load a subagent model first (e.g., when a subagent is dispatched
      // with a different model). Instead, we save the slot on tool_call
      // (before the router switches models) and restore on tool_result.
      if (mainSessionModelId === null) {
        mainSessionModelId = modelId;
        idxInfo("Main session model ID set:", modelId);
      }
    } else {
      idxErr("Could not resolve slot configuration. Model autodiscovery failed (ctx.model not available). Slot save/restore will be skipped for this session.", { modelId, baseUrl });
    }

    // Register subagent lifecycle handlers
    registerSubagentHandlers();
  });

  /**
   * Register handlers for subagent lifecycle events.
   *
   * We listen to the `tool_call` event to detect when the `subagent` tool
   * is invoked. At this point, the main session's model is still loaded in
   * the slot (the router hasn't switched to the subagent model yet). We save
   * the slot here.
   *
   * We listen to the `tool_result` event to detect when the `subagent` tool
   * completes. At this point, the main session's model should be reloaded
   * in the slot. We restore the saved slot here.
   */
  function registerSubagentHandlers(): void {
    // Guard against double-registration (e.g. on session reload)
    if (cleanupFns.length > 0) {
      idxWarn("registerSubagentHandlers SKIPPED (already registered, count=", cleanupFns.length, ")");
      return;
    }

    idxInfo("registerSubagentHandlers registering listeners");

    // tool_call — fired before a tool executes.
    // Detect the `Agent` tool (pi-subagents) and save the slot state before the router
    // switches to the subagent model.
    const unsubToolCall = pi.on("tool_call", async (event) => {
      idxInfo("tool_call event received", { toolName: event.toolName, toolCallId: event.toolCallId });
      if (event.toolName === "Agent") {
        idxInfo("tool_call: Agent tool detected, saving slot");
        await handleSaveMainSlot();
      }
    });
    cleanupFns.push(unsubToolCall);

    // tool_result — fired after a tool completes.
    // Detect the `Agent` tool (pi-subagents) and restore the slot state after the main
    // model has been reloaded.
    const unsubToolResult = pi.on("tool_result", async (event) => {
      idxInfo("tool_result event received", { toolCallId: event.toolCallId, inputKeys: Object.keys(event.input || {}) });
      if (event.input && (event.input as Record<string, unknown>).subagent_type !== undefined) {
        idxInfo("tool_result: Agent tool completed, restoring slot");
        await handleRestoreMainSlot();
      }
    });
    cleanupFns.push(unsubToolResult);

    idxInfo("registerSubagentHandlers DONE, registered", cleanupFns.length, "listeners");
  }

  pi.on("session_shutdown", async () => {
    idxInfo("session_shutdown");
    if (metrics) {
      const summary = metrics.getSessionSummary();
      if (summary) {
        idxInfo("Session metrics summary", JSON.stringify(summary, null, 2));
      }
    }
    for (const unsub of cleanupFns) {
      unsub();
    }
    cleanupFns.length = 0;
    activeSubagentCount = 0;
    state.baseUrl = null;
    state.modelId = null;
  });
}
