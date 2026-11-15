import type { AgentVisibilityEvent as CliVisibilityEvent } from "../../agent.js";
import type { SessionEventBody } from "../index.js";
import { bodySchema } from "../protocolSchemas.js";
import { normalizeSessionEvent, parseProtocolEvent } from "../index.js";
import type { AgentVisibilityEvent, SessionOwnEvent } from "../index.js";

// Context stats are emitted by the turn renderer directly as protocol data;
// mode/plan events use the application Agent's visibility contract.
type CoreEvent =
  | AgentVisibilityEvent
  | SessionOwnEvent
  | CliVisibilityEvent
  | Extract<SessionEventBody, { type: "context_stats" }>;
const display = {
  title: "Reading a.ts",
  body: {
    kind: "file_read",
    path: "a.ts",
    range: { start: 1, count: 10 },
    lines: 10,
  },
} as const;
const tool = { toolCallId: "call", toolName: "read", display };
const result = {
  ...tool,
  args: { path: "a.ts" },
  result: "file contents",
  status: "success",
  durationMs: 10,
  fullOutputPath: "/tmp/output",
} as const;

// One fixture for each discriminator, typed against its corresponding runtime
// shape. Keep this map exhaustive when the core/session event unions change.
const fixtures: { [K in CoreEvent["type"]]: Extract<CoreEvent, { type: K }> } =
  {
    mode_changed: {
      type: "mode_changed",
      mode: "plan",
      planFilePath: "/workspace/plan.md",
    },
    plan_saved: { type: "plan_saved", planFilePath: "/workspace/plan.md" },
    context_stats: { type: "context_stats", text: "Context: 1 turn" },
    turn_started: { type: "turn_started" },
    assistant_text: { type: "assistant_text", delta: "hello" },
    turn_completed: { type: "turn_completed", result: "done" },
    turn_failed: { type: "turn_failed", error: new TypeError("failed") },
    turn_cancelled: {
      type: "turn_cancelled",
      phase: "tool",
      interruptedToolCallIds: ["call"],
    },
    status: { type: "status", status: "working", phase: "model" },
    thinking_delta: { type: "thinking_delta", delta: "thinking" },
    guidance_delivered: {
      type: "guidance_delivered",
      id: "guide",
      text: "use staging",
      iteration: 1,
    },
    tool_started: {
      type: "tool_started",
      ...tool,
      args: { path: "a.ts" },
      argumentChars: 15,
    },
    tool_finished: { type: "tool_finished", ...result },
    tool_failed: { type: "tool_failed", ...result, status: "error" },
    tool_output: {
      type: "tool_output",
      toolCallId: "call",
      stream: "stdout",
      text: "progress",
      elapsedMs: 5,
      droppedBytes: 0,
      transient: true,
    },
    reasoning_summary: {
      type: "reasoning_summary",
      summary: "checked files",
      source: "agent",
    },
    prompt_plan_built: {
      type: "prompt_plan_built",
      snapshot: {
        provider: "local",
        model: "test",
        iteration: 1,
        contextWindowTokens: 1000,
        availableInputBudget: 900,
        plan: {
          messages: [{ role: "user", content: "private prompt" }],
          estimatedPromptTokens: 20,
          reservedOutputTokens: 100,
          includedTurnIds: ["turn"],
          omittedTurnIds: [],
          includedArtifactIds: [],
          usedRollingSummary: false,
          retryLevel: 0,
        },
      },
    },
    session_turn_started: { type: "session_turn_started", commandId: "submit" },
    session_turn_ended: {
      type: "session_turn_ended",
      commandId: "submit",
      outcome: "failed",
      result: "partial",
      error: { name: "Error", message: "failed" },
      undelivered: [{ id: "guide", text: "follow up" }],
    },
    guidance_queued: {
      type: "guidance_queued",
      id: "guide",
      text: "follow up",
    },
    approval_requested: {
      type: "approval_requested",
      request: {
        id: "approve",
        sessionId: "session",
        toolCallId: "call",
        toolName: "read",
        args: { path: "a.ts" },
        capabilities: ["read"],
        target: { kind: "path", path: "/workspace/a.ts" },
        reason: "ask",
        rule: "mode:ask",
        suggestions: [
          { rule: "read", scope: "tool", description: "read files" },
        ],
        display,
      },
    },
    approval_resolved: {
      type: "approval_resolved",
      requestId: "approve",
      resolution: "allow_once",
    },
  };

it.each(Object.entries(fixtures))(
  "normalizes the %s core/session/CLI fixture without a custom wrapper",
  (type, fixture) => {
    const { event, replacedValues } = normalizeSessionEvent(fixture);
    expect(event.type).toBe(type);
    expect(replacedValues).toBe(0);
    expect(
      parseProtocolEvent(JSON.parse(JSON.stringify({ seq: 1, event }))),
    ).toEqual({ seq: 1, event });
  },
);

it("covers every non-custom protocol discriminator", () => {
  const expected = bodySchema.options
    .map((schema) => schema.shape.type.value)
    .filter((type) => type !== "custom");
  expect(Object.keys(fixtures).sort()).toEqual(expected.sort());
});
