/**
 * Slot status tool — check backend connectivity and available slots.
 *
 * Reports the resolved model_id and base_url from the extension state,
 * along with backend health and current subagent activity.
 */

import { Type } from "@sinclair/typebox";

/** Predefined slot names. */
export const SLOT_NAMES = ["main"] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

/** Status tool definition and execution logic. */
export function createStatusTool(
  getBaseUrl: () => string,
  activeSubagentCount: () => number,
  getModelId: () => string | null,
  getResolvedBaseUrl: () => string | null,
  getApiKey: () => string | undefined = () => undefined,
  getSessionDisabled: () => boolean = () => false,
  getLastSavedModelId: () => string | null = () => null,
) {
  return {
    name: "llama_slot_status",
    label: "Llama Slot Status",
    description:
      "Check the current llama-server slot state, resolved model configuration, " +
      "and backend connectivity. Configuration is resolved via runtime autodiscovery from ctx.model.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const backendUrl = getBaseUrl();

        const healthUrl = `${backendUrl}/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);

        let healthOk = false;
        let healthStatus = "unknown";

        try {
          const apiKey = getApiKey();
          const healthResp = await fetch(healthUrl, {
            method: "GET",
            headers: apiKey && apiKey.length > 0 ? { "Authorization": `Bearer ${apiKey}` } : {},
            signal: controller.signal,
          });
          clearTimeout(timer);
          healthOk = healthResp.ok;
          if (healthOk) {
            const healthData = await healthResp.json();
            healthStatus = healthData.status ?? "healthy";
          } else {
            healthStatus = `http_${healthResp.status}`;
          }
        } catch {
          clearTimeout(timer);
          healthStatus = "unreachable";
        }

        const modelId = getModelId();
        const resolvedBaseUrl = getResolvedBaseUrl();

        const sessionDisabled = getSessionDisabled();
        const lastSavedModelId = getLastSavedModelId();

        const slotNames = SLOT_NAMES.map((name) => ({
          name,
          file: name,
        }));

        const result: Record<string, unknown> = {
          backend_url: resolvedBaseUrl ?? backendUrl,
          model_id: modelId,
          backend_status: healthStatus,
          active_subagent_count: activeSubagentCount(),
          available_slots: slotNames,
          last_saved_model: lastSavedModelId,
          note: "Slot files are stored on the llama-server filesystem. " +
            "Slot save/restore is automatic, driven by subagent lifecycle events. " +
            "Configuration is resolved via runtime autodiscovery from ctx.model. " +
            "Use llama_slot_status to check backend connectivity.",
        };

        if (sessionDisabled) {
          result.session_disabled = true;
          result.disable_reason = "Session save/restore has been disabled due to a prior error.";
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          details: {},
          isError: !healthOk || sessionDisabled,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  };
}
