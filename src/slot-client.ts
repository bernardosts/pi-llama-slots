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

/** Build fetch headers, including Bearer token if api_key is provided. */
function buildHeaders(apiKey: string | undefined): Record<string, string> {
  if (apiKey && apiKey.length > 0) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
  }
  return { "Content-Type": "application/json" };
}

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

/** Result of the backend probe operation. */
export interface ProbeResult {
  /** Whether the slots API is available. */
  slotsSupported: boolean;
  /** Reason for the result (success detail or failure reason). */
  reason: string;
}

// ---- Slot operations ----

/** Save the current llama-server slot state to a named file. */
export async function saveSlot(
  baseUrl: string,
  modelId: string,
  slotName: string,
  apiKey?: string,
): Promise<SlotSaveResult> {
  const url = `${baseUrl}/slots/0?action=save`;
  const body = {
    model: modelId,
    filename: slotName,
  };

  logOp("saveSlot", { url, body, hasApiKey: !!apiKey });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
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
  apiKey?: string,
): Promise<boolean> {
  const url = `${baseUrl}/v1/models`;
  logOp("isModelLoaded", { url, modelId, hasApiKey: !!apiKey });

  const response = await fetch(url, { headers: buildHeaders(apiKey) });
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
  apiKey?: string,
): Promise<void> {
  logOp("waitForModelLoaded", { baseUrl, modelId, maxRetries, intervalMs });
  let attempts = 0;
  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    const loaded = await isModelLoaded(baseUrl, modelId, apiKey);
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
  apiKey?: string,
): Promise<void> {
  const url = `${baseUrl}/models/load`;
  const body = { model: modelId };
  logOp("loadModel", { url, body, hasApiKey: !!apiKey });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
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
  apiKey?: string,
): Promise<void> {
  logOp("waitForModelLoadedExplicit", { baseUrl, modelId, maxRetries, intervalMs });
  let attempts = 0;
  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    const loaded = await isModelLoaded(baseUrl, modelId, apiKey);
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

/**
 * Probe the backend to check if the llama slots API is available.
 *
 * Flow:
 *   1. Try GET /v1/models — if this fails, the server may not be OpenAI-compatible.
 *   2. Try POST /slots/0?action=save with a minimal dry-save (2s timeout).
 *      If response has slot-related fields, slots are supported.
 *      If 404/501/other error, slots are NOT supported.
 *
 * If the probe itself fails (network error, timeout), returns { slotsSupported: true }
 * to NOT disable — just skip probing (graceful degradation).
 *
 * @param baseUrl - The llama-server base URL (e.g. http://192.168.3.7:8080)
 * @param apiKey - Optional API key
 * @returns ProbeResult with slotsSupported flag and reason
 */
export async function probeSlotsApi(
  baseUrl: string,
  apiKey?: string,
): Promise<ProbeResult> {
  logOp("probeSlotsApi", { baseUrl, hasApiKey: !!apiKey });

  // Step 1: Try GET /v1/models to verify OpenAI-compatible API is responding
  const modelsUrl = `${baseUrl}/v1/models`;
  let modelsOk = false;
  try {
    const modelsResp = await fetch(modelsUrl, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    modelsOk = modelsResp.ok;
    logResp("probeSlotsApi", { step: "v1/models", ok: modelsOk, status: modelsResp.status });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logResp("probeSlotsApi", { step: "v1/models", error: errMsg });
  }

  // If /v1/models fails, probe failed — but we DON'T disable (graceful degradation).
  // However, if /v1/models works but slots don't, that IS a definitive failure.
  if (!modelsOk) {
    logErr("probeSlotsApi", { reason: "GET /v1/models failed, skipping slot probe" });
    // Return true to not disable — server might still work with different API style
    return { slotsSupported: true, reason: "GET /v1/models failed, skipping slot probe" };
  }

  // Step 2: Try a minimal dry-save with short timeout
  const slotUrl = `${baseUrl}/slots/0?action=save`;
  const probeTimeout = 2000; // 2s max for probe
  const probeController = new AbortController();
  const probeTimer = setTimeout(() => probeController.abort(), probeTimeout);
  const probeStart = Date.now();

  try {
    const probeResp = await fetch(slotUrl, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model: "__probe__", // dummy model name, won't match anything
        filename: "__probe__",
      }),
      signal: probeController.signal,
    });
    clearTimeout(probeTimer);
    const elapsed = Date.now() - probeStart;
    logResp("probeSlotsApi", { step: "slot-save", status: probeResp.status, elapsed_ms: elapsed });

    if (!probeResp.ok) {
      const text = await probeResp.text().catch(() => "");
      const reason = `POST /slots/0?action=save returned HTTP ${probeResp.status}`;
      logErr("probeSlotsApi", { reason, detail: text });
      return { slotsSupported: false, reason };
    }

    // Step 3: Check if response has slot-related fields
    const text = await probeResp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON — slots endpoint returned something unexpected
      return { slotsSupported: false, reason: "POST /slots/0?action=save returned non-JSON response" };
    }

    const obj = parsed as Record<string, unknown>;
    const hasSlotFields =
      typeof obj.id_slot === "number" &&
      typeof obj.n_saved === "number" &&
      typeof obj.timings === "object" &&
      obj.timings !== null;

    if (hasSlotFields) {
      logResp("probeSlotsApi", { step: "slot-save", result: "slots supported", parsed });
      return { slotsSupported: true, reason: "slots API probe succeeded" };
    } else {
      logErr("probeSlotsApi", { step: "slot-save", result: "no slot fields", parsed: obj });
      return { slotsSupported: false, reason: "POST /slots/0?action=save returned response without expected slot fields" };
    }
  } catch (err) {
    const elapsed = Date.now() - probeStart;
    clearTimeout(probeTimer);
    const errMsg = err instanceof Error ? err.message : String(err);
    // Probe itself failed (timeout, network error) — DO NOT disable
    logResp("probeSlotsApi", { step: "slot-save", error: errMsg, elapsed_ms: elapsed });
    return { slotsSupported: true, reason: `probe error (${errMsg}), skipped` };
  }
}

/** Restore a previously saved llama-server slot state from a named file. */
export async function restoreSlot(
  baseUrl: string,
  modelId: string,
  slotName: string,
  apiKey?: string,
): Promise<SlotRestoreResult> {
  const url = `${baseUrl}/slots/0?action=restore`;
  const body = {
    model: modelId,
    filename: slotName,
  };

  logOp("restoreSlot", { url, body, hasApiKey: !!apiKey });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT * 1000);
  const startTime = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
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
