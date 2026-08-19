/**
 * Slot client — save/restore operations against llama-server.
 *
 * Pure HTTP wrapper. All parameters are explicit — no hardcoded defaults,
 * no environment variable fallback, no config file resolution.
 */

import * as fs from "fs";

// ---- Configuration ----

/** Timeout for llama-server operations (seconds). */
export const BACKEND_TIMEOUT = 300; // 5 minutes for large slot restores

/** Polling interval for model load checks (ms). */
export const MODEL_LOAD_POLL_INTERVAL = 1000;

/** Maximum retries when waiting for model to load. */
export const MODEL_LOAD_MAX_RETRIES = 120; // 120 * 1000ms = 120s max (2 minutes)

/** Polling interval for model load status checks (ms). */
export const MODEL_LOAD_STATUS_INTERVAL = 500;

/** Maximum retries when waiting for model load to complete. */
export const MODEL_LOAD_COMPLETE_MAX_RETRIES = 240; // 240 * 500ms = 120s max (2 minutes)

// ---- Debug Logging ----

const LOG_FILE = "./pi-llama-slots.log";

/** Whether debug logging is enabled. Disabled by default; set PI_LLAMA_SLOT_PAGING_LOGGING=1 to enable. */
const LOGGING_ENABLED =
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "1" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "true" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "yes";

/** Append a timestamped line to the debug log. No-op when logging is disabled. */
function log(tag: string, data: unknown): void {
  if (!LOGGING_ENABLED) return;
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${tag}] ${JSON.stringify(data)}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Best-effort logging — never throw
  }
}

/** Log the start of an operation. */
export function logOp(op: string, ...args: unknown[]): void {
  log(`OP:${op}`, args);
}

/** Log a successful API response. */
export function logResp(op: string, resp: unknown): void {
  log(`RESP:${op}`, resp);
}

/** Log an error (will be caught and handled by caller). */
export function logErr(op: string, err: unknown): void {
  log(`ERR:${op}`, err);
}

// ---- Types ----

export interface SlotSaveResult {
  id_slot: number;
  filename: string;
  n_saved: number;
  n_written: number;
  timings: { save_ms: number };
}

export interface SlotRestoreResult {
  id_slot: number;
  filename: string;
  n_restored: number;
  n_read: number;
  timings: { restore_ms: number };
}

// ---- Slot operations ----

/** Save the current llama-server slot state to a named file. */
export async function saveSlot(
  baseUrl: string,
  modelId: string,
  slotName: string,
): Promise<SlotSaveResult> {
  const url = `${baseUrl}/slots/0?action=save`;
  const body = {
    model: modelId,
    filename: slotName,
  };

  logOp("saveSlot", { url, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    const elapsed = Date.now() - startTime;
    clearTimeout(timer);
    logErr("saveSlot", { error: fetchErr, url, elapsed_ms: elapsed });
    throw new Error(`fetch failed after ${elapsed}ms: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
  }

  const elapsed = Date.now() - startTime;
  clearTimeout(timer);
  logResp("saveSlot", { status: response.status, elapsed_ms: elapsed });

  const status = response.status;
  const statusText = response.statusText;
  const responseText = await response.text();

  if (!response.ok) {
    logErr("saveSlot", { status, statusText, body: responseText });
    throw new Error(
      `llama-server slot save failed (HTTP ${status}): ${responseText}`,
    );
  }

  const result = JSON.parse(responseText) as SlotSaveResult;
  logResp("saveSlot", { status, ...result });
  return result;
}

/** Check if a specific model is currently loaded. */
export async function isModelLoaded(
  baseUrl: string,
  modelId: string,
): Promise<boolean> {
  const url = `${baseUrl}/v1/models`;
  logOp("isModelLoaded", { url, modelId });

  const response = await fetch(url);
  if (!response.ok) {
    logErr("isModelLoaded", { status: response.status, statusText: response.statusText });
    return false;
  }

  const data = (await response.json()) as { data: Array<{ id: string; status: { value: string } }> };
  const found = data.data.some(
    (m) => m.id === modelId && m.status.value === "loaded",
  );
  logResp("isModelLoaded", { modelId, found, allModels: data.data.map(m => ({ id: m.id, status: m.status.value })) });
  return found;
}

/**
 * Wait until the specified model is loaded in llama-server.
 * Polls the /v1/models endpoint until the model status is "loaded".
 */
export async function waitForModelLoaded(
  baseUrl: string,
  modelId: string,
  maxRetries: number = MODEL_LOAD_MAX_RETRIES,
  intervalMs: number = MODEL_LOAD_POLL_INTERVAL,
): Promise<void> {
  logOp("waitForModelLoaded", { baseUrl, modelId, maxRetries, intervalMs });
  let attempts = 0;
  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    const loaded = await isModelLoaded(baseUrl, modelId);
    if (loaded) {
      logResp("waitForModelLoaded", { attempts, modelId });
      return; // Model is loaded, proceed
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error(
    `Timed out waiting for model "${modelId}" to load after ${maxRetries * intervalMs}ms (${attempts} attempts)`,
  );
  logErr("waitForModelLoaded", { error: err.message, attempts, modelId });
  throw err;
}

/**
 * Load a model by sending a POST to /models/load.
 * This is the explicit model load endpoint used by llama webui.
 */
export async function loadModel(
  baseUrl: string,
  modelId: string,
): Promise<void> {
  const url = `${baseUrl}/models/load`;
  const body = { model: modelId };
  logOp("loadModel", { url, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsed = Date.now() - startTime;
    clearTimeout(timer);
    logResp("loadModel", { status: response.status, elapsed_ms: elapsed });

    if (!response.ok) {
      const text = await response.text();
      logErr("loadModel", { status: response.status, statusText: response.statusText, body: text });
      throw new Error(`models/load failed (HTTP ${response.status}): ${text}`);
    }
  } catch (fetchErr) {
    const elapsed = Date.now() - startTime;
    clearTimeout(timer);
    logErr("loadModel", { error: fetchErr, elapsed_ms: elapsed });
    throw new Error(`loadModel failed after ${elapsed}ms: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
  }
}

/**
 * Wait for a model to finish loading (status = "loaded") after calling /models/load.
 * Polls /v1/models with a shorter interval for responsiveness.
 */
export async function waitForModelLoadedExplicit(
  baseUrl: string,
  modelId: string,
  maxRetries: number = MODEL_LOAD_COMPLETE_MAX_RETRIES,
  intervalMs: number = MODEL_LOAD_STATUS_INTERVAL,
): Promise<void> {
  logOp("waitForModelLoadedExplicit", { baseUrl, modelId, maxRetries, intervalMs });
  let attempts = 0;
  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    const loaded = await isModelLoaded(baseUrl, modelId);
    if (loaded) {
      logResp("waitForModelLoadedExplicit", { attempts, modelId });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error(
    `Timed out waiting for model "${modelId}" to load after ${maxRetries * intervalMs}ms (${attempts} attempts)`,
  );
  logErr("waitForModelLoadedExplicit", { error: err.message, attempts, modelId });
  throw err;
}

/** Restore a previously saved llama-server slot state from a named file. */
export async function restoreSlot(
  baseUrl: string,
  modelId: string,
  slotName: string,
): Promise<SlotRestoreResult> {
  const url = `${baseUrl}/slots/0?action=restore`;
  const body = {
    model: modelId,
    filename: slotName,
  };

  logOp("restoreSlot", { url, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    const elapsed = Date.now() - startTime;
    clearTimeout(timer);
    logErr("restoreSlot", { error: fetchErr, url, elapsed_ms: elapsed });
    throw new Error(`fetch failed after ${elapsed}ms: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
  }

  const elapsed = Date.now() - startTime;
  clearTimeout(timer);
  logResp("restoreSlot", { status: response.status, elapsed_ms: elapsed });

  const status = response.status;
  const statusText = response.statusText;
  const responseText = await response.text();

  if (!response.ok) {
    logErr("restoreSlot", { status, statusText, body: responseText });
    throw new Error(
      `llama-server slot restore failed (HTTP ${status}): ${responseText}`,
    );
  }

  const result = JSON.parse(responseText) as SlotRestoreResult;
  logResp("restoreSlot", { status, ...result });
  return result;
}
