import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatStreamEvent } from "@propio-ai/providers";
import { inspectTraceExport } from "./inspection.js";
import { readTraceJournal } from "./journal.js";
import type { TraceMaterialReference } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const streamStringField: Readonly<Record<string, string>> = {
  assistant_text: "delta",
  thinking_delta: "delta",
  status: "status",
  reasoning_summary: "summary",
  terminal: "stopReason",
};

function isStreamEvent(value: unknown): value is ChatStreamEvent {
  if (!isRecord(value)) return false;
  if (value.type === undefined) return typeof value.delta === "string";
  if (value.type === "tool_calls") return Array.isArray(value.toolCalls);
  if (typeof value.type !== "string") return false;
  const field = streamStringField[value.type];
  return (
    typeof field === "string" &&
    typeof value[field] === "string" &&
    (value.type !== "reasoning_summary" || typeof value.source === "string")
  );
}

/**
 * Read a completed response from a verified, portable full-capture bundle.
 * This is deliberately not an LLMProvider: reading it cannot call a provider,
 * execute a tool, or resume an agent run.
 */
export function loadRecordedProviderResponse(
  exportDirectory: string,
  requestId: string,
): ReadonlyArray<ChatStreamEvent> {
  const { manifest } = inspectTraceExport(exportDirectory);
  if (manifest.version !== 4) {
    throw new Error("Recorded response playback requires a full trace export");
  }
  const events = readTraceJournal(
    path.join(exportDirectory, "events.jsonl"),
  ).events.filter(
    (event) =>
      event.type === "provider_response_captured" &&
      event.identity.requestId === requestId,
  );
  if (events.length !== 1) {
    throw new Error(
      `Expected exactly one recorded response for request ${requestId}`,
    );
  }
  const response = events[0]!;
  const payload = response.payload;
  if (!isRecord(payload) || payload.completed !== true) {
    throw new Error(`Recorded response for request ${requestId} is incomplete`);
  }
  const material = payload.responseMaterial;
  if (!isRecord(material) || typeof material.path !== "string") {
    throw new Error(
      `Recorded response for request ${requestId} has no material`,
    );
  }
  const included = manifest.material.some(
    (entry) =>
      entry.eventId === response.eventId &&
      entry.kind === "provider_payload" &&
      entry.status === "included" &&
      entry.path === material.path,
  );
  if (!included) {
    throw new Error(
      `Recorded response for request ${requestId} is not included`,
    );
  }
  const ref = material as unknown as TraceMaterialReference;
  if (ref.encoding !== "json") {
    throw new Error("Recorded response material is not JSON");
  }
  const recorded = JSON.parse(
    fs.readFileSync(path.join(exportDirectory, ref.path), "utf8"),
  ) as unknown;
  if (
    !isRecord(recorded) ||
    recorded.completed !== true ||
    !Array.isArray(recorded.events) ||
    !recorded.events.every(isStreamEvent)
  ) {
    throw new Error("Recorded response material is invalid");
  }
  return recorded.events;
}

/** Yield only recorded events; never invoke the live provider or agent. */
export async function* playRecordedProviderResponse(
  exportDirectory: string,
  requestId: string,
): AsyncIterable<ChatStreamEvent> {
  for (const event of loadRecordedProviderResponse(
    exportDirectory,
    requestId,
  )) {
    yield event;
  }
}
