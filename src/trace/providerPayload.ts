import type { ProviderTraceEvent } from "@propio-ai/providers";
import type { AgentTraceRecorder } from "./types.js";

/** Keep private request bodies in content-addressed material, not JSONL. */
export function capturedProviderEventPayload(
  event: ProviderTraceEvent,
  recorder: AgentTraceRecorder,
): unknown {
  if (event.type !== "provider_attempt_payload") return event;
  const { requestBody, ...metadata } = event;
  return {
    ...metadata,
    bodyMaterial:
      requestBody === undefined
        ? undefined
        : recorder.captureMaterial?.(requestBody),
  };
}
