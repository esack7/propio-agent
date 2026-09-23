import type { ProviderTraceEvent } from "@propio-ai/providers";
import type { AgentTraceRecorder } from "./types.js";

/**
 * The payload event is additive in providers. Keep the agent buildable against
 * the previously published package while the coordinated release is pending.
 */
export function capturedProviderEventPayload(
  event: ProviderTraceEvent,
  recorder: AgentTraceRecorder,
): unknown {
  const candidate = event as unknown as Record<string, unknown>;
  if (candidate.type !== "provider_attempt_payload") return event;
  const { requestBody, ...metadata } = candidate;
  return {
    ...metadata,
    bodyMaterial:
      requestBody === undefined
        ? undefined
        : recorder.captureMaterial?.(requestBody),
  };
}
