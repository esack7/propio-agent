import type { ApprovalAnswer } from "../policy/index.js";

/**
 * What a frontend may ask of a session. Every command is plain JSON, so the
 * same value can come from a keypress in this process, a browser, or another
 * process. `commandId` is chosen by the sender and echoed in the result and
 * in the events the command causes.
 */
export type SessionCommand =
  | {
      readonly type: "submit";
      readonly commandId: string;
      readonly text: string;
      /** Images as strings: a data URL or base64, as providers accept them. */
      readonly images?: readonly string[];
    }
  /** Say something to a running turn without stopping it. */
  | {
      readonly type: "guide";
      readonly commandId: string;
      readonly text: string;
    }
  /** Stop the running turn, keeping the work it completed. */
  | { readonly type: "interrupt"; readonly commandId: string }
  | {
      readonly type: "answer_approval";
      readonly commandId: string;
      readonly answer: ApprovalAnswer;
    };

export type CommandRejection =
  /** A submit while a turn is running. */
  | "turn_running"
  /** A guide or interrupt with no turn running. */
  | "no_turn"
  /** An answer for a request that is not waiting. */
  | "unknown_approval"
  /** The value is not a command. */
  | "invalid";

export type CommandResult =
  | { readonly commandId: string; readonly accepted: true }
  | {
      readonly commandId: string;
      readonly accepted: false;
      readonly code: CommandRejection;
      readonly message: string;
    };

export type ParsedSessionCommand =
  | { readonly ok: true; readonly command: SessionCommand }
  | {
      readonly ok: false;
      readonly commandId: string;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FieldCheck = (value: unknown) => boolean;
const isText: FieldCheck = (value) => typeof value === "string";
const isNonEmptyText: FieldCheck = (value) =>
  typeof value === "string" && value.trim().length > 0;
const isOptionalText: FieldCheck = (value) =>
  value === undefined || typeof value === "string";
const isImages: FieldCheck = (value) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every((image) => typeof image === "string" && image.length > 0));

/** Every field a value may have, and what each must be. Nothing else is allowed. */
type Shape = Readonly<Record<string, FieldCheck>>;

function shapeProblem(
  value: Record<string, unknown>,
  shape: Shape,
  label: string,
): string | undefined {
  const unknown = Object.keys(value).find(
    (key) => !Object.prototype.hasOwnProperty.call(shape, key),
  );
  if (unknown !== undefined) return `${label} has unknown field ${unknown}`;
  const invalid = Object.keys(shape).find((key) => !shape[key]!(value[key]));
  return invalid === undefined ? undefined : `${label}.${invalid} is not valid`;
}

const ANSWER_SHAPES: Readonly<Record<string, Shape>> = {
  allow_once: { requestId: isNonEmptyText, decision: isText },
  allow_session: {
    requestId: isNonEmptyText,
    decision: isText,
    rule: isNonEmptyText,
  },
  allow_always: {
    requestId: isNonEmptyText,
    decision: isText,
    rule: isNonEmptyText,
  },
  deny: { requestId: isNonEmptyText, decision: isText, reason: isOptionalText },
};

const isAnswer: FieldCheck = (value) => {
  if (!isRecord(value) || typeof value.decision !== "string") return false;
  const shape = Object.prototype.hasOwnProperty.call(
    ANSWER_SHAPES,
    value.decision,
  )
    ? ANSWER_SHAPES[value.decision]
    : undefined;
  return (
    shape !== undefined && shapeProblem(value, shape, "answer") === undefined
  );
};

const COMMAND_SHAPES: Readonly<Record<SessionCommand["type"], Shape>> = {
  submit: {
    type: isText,
    commandId: isNonEmptyText,
    text: isText,
    images: isImages,
  },
  guide: { type: isText, commandId: isNonEmptyText, text: isNonEmptyText },
  interrupt: { type: isText, commandId: isNonEmptyText },
  answer_approval: {
    type: isText,
    commandId: isNonEmptyText,
    answer: isAnswer,
  },
};

function commandProblem(value: Record<string, unknown>): string | undefined {
  const type = value.type;
  if (
    typeof type !== "string" ||
    !Object.prototype.hasOwnProperty.call(COMMAND_SHAPES, type)
  )
    return "type is not a known command";
  return shapeProblem(
    value,
    COMMAND_SHAPES[type as SessionCommand["type"]],
    type,
  );
}

/**
 * Check a value that arrived from outside, such as a parsed request body.
 * A transport calls this before dispatching; `AgentSession.dispatch` calls
 * it too, so a malformed command is refused rather than half-applied.
 */
export function parseSessionCommand(value: unknown): ParsedSessionCommand {
  const commandId =
    isRecord(value) && typeof value.commandId === "string"
      ? value.commandId
      : "";
  if (!isRecord(value))
    return { ok: false, commandId, message: "command must be an object" };
  if (commandId.length === 0)
    return {
      ok: false,
      commandId,
      message: "commandId must be a non-empty string",
    };
  const problem = commandProblem(value);
  return problem === undefined
    ? { ok: true, command: value as unknown as SessionCommand }
    : { ok: false, commandId, message: problem };
}

/** Encode image bytes as base64 for a submit command. */
export function encodeCommandImage(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
