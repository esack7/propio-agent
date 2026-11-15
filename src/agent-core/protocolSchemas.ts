import { z } from "zod";
const text = z.string();
const count = z.number().int().nonnegative().safe();
const number = z.number().finite();
const optionalText = text.optional();
const line = z.strictObject({
  op: z.enum([" ", "+", "-"]),
  text,
  noNewline: z.literal(true).optional(),
  truncated: z.literal(true).optional(),
});
const displaySchema = z.strictObject({
  title: text,
  error: optionalText,
  body: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("diff"),
      path: text,
      operation: z.enum(["create", "replace"]),
      hunks: z.array(
        z.strictObject({
          oldStart: count,
          newStart: count,
          lines: z.array(line),
        }),
      ),
      added: count,
      removed: count,
      truncated: z.boolean(),
      baseHash: optionalText,
      stale: z.boolean().optional(),
      unavailable: optionalText,
    }),
    z.strictObject({
      kind: z.literal("command"),
      command: text,
      cwd: optionalText,
      exitCode: z.number().int().optional(),
      classification: z
        .enum([
          "succeeded",
          "nonzero_exit",
          "timed_out",
          "cancelled",
          "output_limit",
          "launch_failed",
        ])
        .optional(),
      stdoutTail: optionalText,
      stderrTail: optionalText,
      stdoutLines: count.optional(),
      stderrLines: count.optional(),
      truncated: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("file_read"),
      path: text,
      range: z
        .strictObject({ start: count, count: count.optional() })
        .optional(),
      lines: count.optional(),
    }),
    z.strictObject({
      kind: z.literal("search"),
      mode: z.enum(["content", "files", "list"]),
      pattern: optionalText,
      scope: optionalText,
      matches: count.optional(),
      files: count.optional(),
      sample: z.array(text).optional(),
    }),
    z.strictObject({
      kind: z.literal("generic"),
      fields: z.array(z.strictObject({ key: text, value: text })),
      resultPreview: optionalText,
      truncated: z.boolean(),
    }),
  ]),
});
const json = z.json();
const object = z.record(text, json);
const error = z.strictObject({ name: text, message: text });
const guidance = z.strictObject({ id: text, text });
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: text }),
  z.strictObject({
    kind: z.literal("command"),
    command: text,
    detached: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("mcp"), serverPrefix: text }),
]);
const approval = z.strictObject({
  id: text,
  sessionId: optionalText,
  toolCallId: optionalText,
  toolName: text,
  args: object,
  capabilities: z.array(
    z.enum(["read", "workspace_write", "process", "network", "external"]),
  ),
  target: target.optional(),
  reason: text,
  rule: text,
  suggestions: z.array(
    z.strictObject({
      rule: text,
      scope: z.enum(["exact", "tool", "server", "capability"]),
      description: text,
    }),
  ),
  display: displaySchema.optional(),
});
const tool = { toolCallId: text, toolName: text, display: displaySchema };
const result = {
  ...tool,
  durationMs: number.nonnegative(),
  fullOutputPath: optionalText,
  result: optionalText,
  args: object.optional(),
  status: z
    .enum([
      "success",
      "error",
      "tool_not_found",
      "tool_disabled",
      "invalid_arguments",
    ])
    .optional(),
};
export const bodySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session_turn_started"), commandId: text }),
  z.strictObject({
    type: z.literal("session_turn_ended"),
    commandId: text,
    outcome: z.enum(["completed", "cancelled", "failed"]),
    result: optionalText,
    error: error.optional(),
    undelivered: z.array(guidance),
  }),
  z.strictObject({ type: z.literal("guidance_queued"), ...guidance.shape }),
  z.strictObject({ type: z.literal("approval_requested"), request: approval }),
  z.strictObject({
    type: z.literal("approval_resolved"),
    requestId: text,
    resolution: z.enum([
      "allow_once",
      "allow_session",
      "allow_always",
      "deny",
      "withdrawn",
    ]),
  }),
  z.strictObject({ type: z.literal("turn_started") }),
  z.strictObject({ type: z.literal("assistant_text"), delta: text }),
  z.strictObject({ type: z.literal("turn_completed"), result: text }),
  z.strictObject({ type: z.literal("turn_failed"), error }),
  z.strictObject({
    type: z.literal("turn_cancelled"),
    phase: z.enum(["model", "tool"]).optional(),
    interruptedToolCallIds: z.array(text).optional(),
  }),
  z.strictObject({
    type: z.literal("status"),
    status: text,
    phase: optionalText,
  }),
  z.strictObject({ type: z.literal("thinking_delta"), delta: text }),
  z.strictObject({
    type: z.literal("guidance_delivered"),
    ...guidance.shape,
    iteration: count,
  }),
  z.strictObject({
    type: z.literal("tool_started"),
    ...tool,
    args: object,
    argumentChars: count,
  }),
  z.strictObject({ type: z.literal("tool_finished"), ...result }),
  z.strictObject({ type: z.literal("tool_failed"), ...result }),
  z.strictObject({
    type: z.literal("tool_output"),
    toolCallId: text,
    stream: z.enum(["stdout", "stderr"]),
    text,
    droppedBytes: count,
    elapsedMs: number.nonnegative(),
    transient: z.literal(true),
  }),
  z.strictObject({
    type: z.literal("reasoning_summary"),
    summary: text,
    source: z.enum(["provider", "agent"]),
  }),
  z.strictObject({
    type: z.literal("prompt_plan_built"),
    snapshot: z.strictObject({
      provider: text,
      model: text,
      iteration: count,
      contextWindowTokens: count,
      availableInputBudget: count,
      estimatedPromptTokens: count,
      includedTurns: count,
      omittedTurns: count,
      retryLevel: count,
      usedRollingSummary: z.boolean(),
    }),
  }),
  z.strictObject({
    type: z.literal("mode_changed"),
    mode: z.enum(["execute", "plan", "discover"]),
    planFilePath: optionalText,
  }),
  z.strictObject({ type: z.literal("plan_saved"), planFilePath: text }),
  z.strictObject({ type: z.literal("context_stats"), text }),
  z.strictObject({ type: z.literal("custom"), value: json }),
]);
export const protocolSchema = z.strictObject({
  seq: count.positive(),
  event: bodySchema,
  replacedValues: count.optional(),
});
export type SessionEventBody = Readonly<z.infer<typeof bodySchema>>;
export type ProtocolEvent = Readonly<
  Omit<z.infer<typeof protocolSchema>, "event"> & { event: SessionEventBody }
>;
