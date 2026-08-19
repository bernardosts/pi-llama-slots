/**
 * Metrics module — lightweight, no-async, append-only JSON-lines logger.
 *
 * Captures save/restore call timings and sizes for the KV cache swap path.
 * Only active when PI_LLAMA_SLOT_PAGING_LOGGING is set (truthy).
 * Writes to the same file as idxLog (pi-llama-slots.log), tagged [METRICS].
 */

import * as fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsEntry {
  timestamp: string;              // ISO 8601
  operation: "save" | "restore" | "restore_full";
  model_id: string | null;
  // From llama-server response — save
  n_saved?: number;
  n_written?: number;
  server_save_ms?: number;
  // From llama-server response — restore
  n_restored?: number;
  n_read?: number;
  server_restore_ms?: number;
  // Wall-clock timing — what WE measure
  wall_save_ms?: number;
  wall_restore_model_load_ms?: number;
  wall_restore_wait_ms?: number;
  wall_restore_slot_ms?: number;
  wall_restore_full_ms?: number;
  status: "ok" | "error";
  error?: string;
}

// ---------------------------------------------------------------------------
// Per-operation in-flight state
// ---------------------------------------------------------------------------

interface SaveState {
  wallStart: number;
  modelId: string | null;
}

interface RestoreState {
  wallStart: number;
  modelId: string | null;
  wallRestoreModelLoadMs: number;
  wallRestoreWaitMs: number;
  wallRestoreSlotMs: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOG_FILE = "./pi-llama-slots.log";
const MAX_LOG_BYTES = 1_000_000; // 1 MB

const METRICS_ENABLED =
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "1" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "true" ||
  process.env.PI_LLAMA_SLOT_PAGING_LOGGING === "yes";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export function createMetrics() {
  // Guard: metrics only when logging is enabled
  if (!METRICS_ENABLED) {
    return null;
  }

  const entries: MetricsEntry[] = [];

  // In-flight state (one at a time for this extension's usage pattern)
  let saveState: SaveState | null = null;
  let restoreState: RestoreState | null = null;

  // ------------------------------------------------------------------
  // Persistence helpers
  // ------------------------------------------------------------------

  function appendEntry(entry: MetricsEntry): void {
    const line = "[METRICS] " + JSON.stringify(entry) + "\n";
    try {
      // Check rotation before appending
      try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_LOG_BYTES) {
          rotateLog();
        }
      } catch {
        // File doesn't exist yet — fine
      }
      fs.appendFileSync(LOG_FILE, line);
    } catch {
      // Best-effort logging — never throw
    }
  }

  function rotateLog(): void {
    try {
      const data = fs.readFileSync(LOG_FILE, "utf-8");
      const allLines = data.split("\n");

      // Collect recent [METRICS] lines from the end
      const metricsLines: string[] = [];
      for (let i = allLines.length - 1; i >= 0; i--) {
        const line = allLines[i].trim();
        if (!line) continue;
        if (line.startsWith("[METRICS]")) {
          metricsLines.unshift(line);
          if (metricsLines.join("\n").length > MAX_LOG_BYTES * 0.7) break;
        }
      }

      // Write back: old non-metrics content that fits + kept metrics lines
      const kept = metricsLines.join("\n") + "\n";
      let remaining = kept.length;
      const newLines: string[] = [];
      for (let i = 0; i < allLines.length && remaining < MAX_LOG_BYTES; i++) {
        const line = allLines[i];
        if (line.trim().startsWith("[METRICS]")) continue; // skip old metrics lines
        newLines.push(line);
        remaining += line.length + 1;
      }
      fs.writeFileSync(LOG_FILE, newLines.join("\n") + "\n" + kept);
    } catch {
      // Rotation failed — best effort
    }
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------

  function startSave(modelId: string | null): void {
    saveState = {
      wallStart: Date.now(),
      modelId,
    };
  }

  function endSave(result: unknown, error?: string): void {
    const ts = new Date().toISOString();
    const entry: MetricsEntry = {
      timestamp: ts,
      operation: "save",
      model_id: saveState?.modelId ?? null,
      status: error ? "error" : "ok",
    };

    if (error) {
      entry.error = error;
      // Compute wall time even on error
      if (saveState) {
        entry.wall_save_ms = Date.now() - saveState.wallStart;
      }
      appendEntry(entry);
      saveState = null;
      return;
    }

    // Parse SlotSaveResult-like object
    const r = result as Record<string, unknown> | undefined;
    const timings = r?.timings as Record<string, unknown> | undefined;

    entry.n_saved = typeof r?.n_saved === "number" ? r.n_saved : undefined;
    entry.n_written = typeof r?.n_written === "number" ? r.n_written : undefined;
    entry.server_save_ms =
      typeof timings?.save_ms === "number" ? timings.save_ms : undefined;

    if (saveState) {
      entry.wall_save_ms = Date.now() - saveState.wallStart;
    }

    appendEntry(entry);
    saveState = null;
  }

  function startRestore(modelId: string | null): void {
    restoreState = {
      wallStart: Date.now(),
      modelId,
      wallRestoreModelLoadMs: 0,
      wallRestoreWaitMs: 0,
      wallRestoreSlotMs: 0,
    };
  }

  function endRestoreModelLoad(elapsedMs: number): void {
    if (restoreState) {
      restoreState.wallRestoreModelLoadMs = elapsedMs;
    }
  }

  function endRestoreWait(elapsedMs: number): void {
    if (restoreState) {
      restoreState.wallRestoreWaitMs = elapsedMs;
    }
  }

  function startRestoreSlot(): void {
    // Marks the start of the slot restore phase.
    // The actual timing is computed by endRestoreSlot(elapsedMs).
  }

  function endRestoreSlot(elapsedMs: number, serverResult?: Record<string, unknown>): void {
    if (!restoreState) return;

    const ts = new Date().toISOString();
    const entry: MetricsEntry = {
      timestamp: ts,
      operation: "restore_full",
      model_id: restoreState.modelId,
      wall_restore_model_load_ms: restoreState.wallRestoreModelLoadMs,
      wall_restore_wait_ms: restoreState.wallRestoreWaitMs,
      wall_restore_slot_ms: elapsedMs,
      wall_restore_full_ms: Date.now() - restoreState.wallStart,
      status: "ok",
    };

    // If server result provided, extract KV-cache data
    if (serverResult) {
      const r = serverResult as Record<string, unknown>;
      const timings = r?.timings as Record<string, unknown> | undefined;
      entry.n_restored = typeof r?.n_restored === "number" ? r.n_restored : undefined;
      entry.n_read = typeof r?.n_read === "number" ? r.n_read : undefined;
      entry.server_restore_ms =
        typeof timings?.restore_ms === "number" ? timings.restore_ms : undefined;
    }

    appendEntry(entry);
    restoreState = null;
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------

  function getSessionSummary(): {
    total_saves: number;
    total_restores: number;
    total_restore_full_ms: number;
    avg_save_ms: number;
    avg_restore_slot_ms: number;
    avg_restore_full_ms: number;
    max_save_ms: number;
    max_restore_slot_ms: number;
    max_restore_full_ms: number;
    min_save_ms: number;
    min_restore_slot_ms: number;
    min_restore_full_ms: number;
    saves_over_10s: number;
    restores_over_30s: number;
  } | null {
    if (entries.length === 0) return null;

    const saves = entries.filter(e => e.operation === "save");
    const restores = entries.filter(e => e.operation === "restore_full");

    const saveMss = saves.map(e => e.wall_save_ms ?? 0).filter(v => v > 0);
    const restoreSlotMss = restores.map(e => e.wall_restore_slot_ms ?? 0).filter(v => v > 0);
    const restoreFullMss = restores.map(e => e.wall_restore_full_ms ?? 0).filter(v => v > 0);

    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const mx = (arr: number[]) => (arr.length > 0 ? Math.max(...arr) : 0);
    const mn = (arr: number[]) => (arr.length > 0 ? Math.min(...arr) : 0);

    return {
      total_saves: saves.length,
      total_restores: restores.length,
      total_restore_full_ms: restoreFullMss.reduce((a, b) => a + b, 0),
      avg_save_ms: avg(saveMss),
      avg_restore_slot_ms: avg(restoreSlotMss),
      avg_restore_full_ms: avg(restoreFullMss),
      max_save_ms: mx(saveMss),
      max_restore_slot_ms: mx(restoreSlotMss),
      max_restore_full_ms: mx(restoreFullMss),
      min_save_ms: mn(saveMss),
      min_restore_slot_ms: mn(restoreSlotMss),
      min_restore_full_ms: mn(restoreFullMss),
      saves_over_10s: saves.filter(e => (e.wall_save_ms ?? 0) > 10_000).length,
      restores_over_30s: restores.filter(e => (e.wall_restore_full_ms ?? 0) > 30_000).length,
    };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  return {
    startSave,
    endSave,
    startRestore,
    endRestoreModelLoad,
    endRestoreWait,
    startRestoreSlot,
    endRestoreSlot,
    getSessionSummary,
  };
}
