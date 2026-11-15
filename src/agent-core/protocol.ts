import {
  bodySchema,
  protocolSchema,
  type ProtocolEvent,
  type SessionEventBody,
} from "./protocolSchemas.js";
import { copyJson, freezeJson } from "./protocolJson.js";
import type { AgentVisibilityEvent, PromptPlanSnapshot } from "./events.js";
import type { SessionOwnEvent } from "./session.js";
export type { ProtocolEvent, SessionEventBody } from "./protocolSchemas.js";

export function summarizePromptPlan(snapshot: PromptPlanSnapshot) {
  const { plan, ...metadata } = snapshot;
  return {
    ...metadata,
    estimatedPromptTokens: plan.estimatedPromptTokens,
    includedTurns: plan.includedTurnIds.length,
    omittedTurns: plan.omittedTurnIds.length,
    retryLevel: plan.retryLevel,
    usedRollingSummary: plan.usedRollingSummary,
  };
}

// The constraint fails compilation when a core/session discriminator has no schema.
// Generic runner events still retain the custom-envelope fallback below.
type ProtocolBody<T extends SessionEventBody["type"]> = Extract<
  SessionEventBody,
  { type: T }
>;

/** Normalize trusted runtime data. Generic events that do not fit a built-in schema are wrapped. */
export function normalizeSessionEvent(input: unknown): {
  event: ProtocolBody<
    | AgentVisibilityEvent["type"]
    | SessionOwnEvent["type"]
    | SessionEventBody["type"]
  >;
  replacedValues: number;
} {
  // Optional undefined properties are omitted; undefined inside args is counted.
  const copied = copyJson(normalizeRuntimeFields(input), true);
  const candidate = copied.value;
  const type = eventType(candidate);
  const parsed =
    type === "custom" ? undefined : bodySchema.safeParse(candidate);
  const event = parsed?.success
    ? parsed.data
    : bodySchema.parse({ type: "custom", value: candidate });
  return { event: freezeJson(event), replacedValues: copied.replacedValues };
}

function eventType(value: unknown): unknown {
  return value && typeof value === "object" && "type" in value
    ? value.type
    : undefined;
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    "message" in error &&
    typeof error.name === "string" &&
    typeof error.message === "string"
  )
    return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function normalizeRuntimeFields(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  if (eventType(input) === "turn_failed" && "error" in input)
    return { type: "turn_failed", error: normalizeError(input.error) };
  if (eventType(input) === "prompt_plan_built" && "snapshot" in input)
    return normalizePlanEvent(input.snapshot);
  return input;
}

function normalizePlanEvent(snapshot: unknown): unknown {
  return {
    type: "prompt_plan_built",
    snapshot:
      snapshot && typeof snapshot === "object" && "plan" in snapshot
        ? summarizePromptPlan(snapshot as PromptPlanSnapshot)
        : snapshot,
  };
}

const validatedRecords = new WeakSet<object>();

/** Strict untrusted boundary: no coercion, unknown variants/fields, or non-JSON. */
export function parseProtocolEvent(value: unknown): ProtocolEvent {
  if (value && typeof value === "object" && validatedRecords.has(value))
    return value as ProtocolEvent;
  const event = freezeJson(protocolSchema.parse(copyJson(value, false).value));
  validatedRecords.add(event);
  return event;
}

export interface SessionEventLog {
  readonly lastSequence?: number;
  append(event: ProtocolEvent): void;
}

/** In-memory spike only; no persistence or retention policy. */
export class InMemorySessionEventLog implements SessionEventLog {
  private readonly events: ProtocolEvent[] = [];
  get lastSequence(): number | undefined {
    return this.events[this.events.length - 1]?.seq;
  }
  append(value: ProtocolEvent): void {
    const event = parseProtocolEvent(value);
    const previous = this.events[this.events.length - 1];
    if (previous && event.seq !== previous.seq + 1)
      throw new Error("Event log sequence must be contiguous");
    this.events.push(event);
  }
  after(seq: number): readonly ProtocolEvent[] {
    if (!Number.isSafeInteger(seq) || seq < 0)
      throw new RangeError("Invalid event cursor");
    return this.events.slice(Math.max(0, seq - (this.events[0]?.seq ?? 1) + 1));
  }
}

/** Build a trusted record once; logs can reuse its validated immutable data. */
export function createProtocolEvent(
  seq: number,
  input: unknown,
): ProtocolEvent {
  const normalized = normalizeSessionEvent(input);
  const record = Object.freeze({
    seq,
    event: normalized.event,
    ...(normalized.replacedValues
      ? { replacedValues: normalized.replacedValues }
      : {}),
  });
  validatedRecords.add(record);
  return record;
}
