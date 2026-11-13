import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type {
  ApprovalAnswer,
  ApprovalRequest,
  GrantSuggestion,
} from "../policy/index.js";
import { readLineFromKeys } from "./keyLineReader.js";
import { createPromptState } from "./promptState.js";
import type { TerminalUi } from "./terminal.js";
import { visibleText } from "./visibleText.js";

const ARGUMENT_PREVIEW_LIMIT = 400;

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > ARGUMENT_PREVIEW_LIMIT
    ? `${text.slice(0, ARGUMENT_PREVIEW_LIMIT)}…`
    : text;
}

function operationLines(request: ApprovalRequest): string[] {
  const { target, args } = request;
  if (target?.kind === "command") {
    return [
      `Command: ${visibleText(target.command)}`,
      ...(args.cwd === undefined
        ? []
        : [`Directory: ${visibleText(String(args.cwd))}`]),
      ...(args.env === undefined
        ? []
        : [`Environment: ${visibleText(preview(args.env))}`]),
    ];
  }
  if (target?.kind === "path") return [`Path: ${visibleText(target.path)}`];
  return [`Arguments: ${visibleText(preview(args))}`];
}

/**
 * What is being asked, built only from the request. Every field that came
 * from the model, a tool, or a settings file is passed through `visibleText`
 * before it reaches the terminal.
 */
export function formatApprovalRequest(request: ApprovalRequest): string[] {
  return [
    `${visibleText(request.toolName)} needs approval.`,
    ...operationLines(request),
    `Reason: ${visibleText(request.reason)}`,
  ];
}

function choiceLines(request: ApprovalRequest): string[] {
  const grants = request.suggestions.length > 0;
  return [
    "  y  allow once",
    ...(grants
      ? [
          "  s  allow for this session",
          "  a  always allow (saved to your settings)",
        ]
      : []),
    '  n  deny; a reason for the model may follow, as in "n use staging"',
  ];
}

function grantLine(suggestion: GrantSuggestion, index: number): string {
  return `  ${index + 1}. ${visibleText(suggestion.description)}  [${visibleText(suggestion.rule)}]`;
}

/** How the prompt reaches the operator; the terminal in the CLI. */
export interface ApprovalPromptIo {
  /** Show lines above the question. */
  show(lines: readonly string[]): void;
  /** Ask for one line. Null means the question was withdrawn. */
  readLine(promptText: string, signal?: AbortSignal): Promise<string | null>;
}

type GrantDecision = "allow_session" | "allow_always";

/** A grant, `back` to choose again, or `closed` when the question is withdrawn. */
async function chooseGrant(
  request: ApprovalRequest,
  scope: string,
  io: ApprovalPromptIo,
  signal?: AbortSignal,
): Promise<GrantSuggestion | "back" | "closed"> {
  const { suggestions } = request;
  if (suggestions.length === 0) {
    io.show(["No grant covers this call; allow it once or deny it."]);
    return "back";
  }
  io.show([`Allow ${scope}:`, ...suggestions.map(grantLine)]);
  for (;;) {
    const line = await io.readLine(
      `Which? [1-${suggestions.length}, Enter to go back] `,
      signal,
    );
    if (line === null) return "closed";
    const text = line.trim();
    if (text === "") return "back";
    const chosen = /^\d+$/.test(text)
      ? suggestions[Number(text) - 1]
      : undefined;
    if (chosen) return chosen;
    io.show([`Enter a number from 1 to ${suggestions.length}.`]);
  }
}

const GRANT_CHOICES: Readonly<
  Record<string, { decision: GrantDecision; scope: string }>
> = {
  s: { decision: "allow_session", scope: "for this session" },
  session: { decision: "allow_session", scope: "for this session" },
  a: { decision: "allow_always", scope: "always" },
  always: { decision: "allow_always", scope: "always" },
};
const ALLOW_ONCE = new Set(["y", "yes"]);
const DENY = new Set(["", "n", "no", "d", "deny"]);

type Choice =
  | { kind: "once" }
  | { kind: "deny"; reason: string }
  | { kind: "grant"; decision: GrantDecision; scope: string }
  | { kind: "unknown" };

/** What a typed line asks for. Only an explicit word allows anything. */
function readChoice(line: string): Choice {
  const [word = "", ...rest] = line.trim().split(/\s+/);
  const choice = word.toLowerCase();
  if (ALLOW_ONCE.has(choice)) return { kind: "once" };
  if (DENY.has(choice)) return { kind: "deny", reason: rest.join(" ") };
  return Object.prototype.hasOwnProperty.call(GRANT_CHOICES, choice)
    ? { kind: "grant", ...GRANT_CHOICES[choice]! }
    : { kind: "unknown" };
}

function denial(requestId: string, reason = ""): ApprovalAnswer {
  return reason
    ? { requestId, decision: "deny", reason }
    : { requestId, decision: "deny" };
}

/**
 * Put one request to the operator. Allowing takes an explicit choice; an
 * empty line, a withdrawn question, or a cancelled turn is a denial.
 */
export async function askOperator(
  request: ApprovalRequest,
  io: ApprovalPromptIo,
  signal?: AbortSignal,
): Promise<ApprovalAnswer> {
  const requestId = request.id;
  io.show([...formatApprovalRequest(request), "", ...choiceLines(request)]);
  for (;;) {
    const line = await io.readLine("Allow? [y/s/a/N] ", signal);
    if (line === null) return denial(requestId);
    const choice = readChoice(line);
    if (choice.kind === "once") return { requestId, decision: "allow_once" };
    if (choice.kind === "deny") return denial(requestId, choice.reason);
    if (choice.kind === "unknown") {
      io.show(["Enter y, s, a, or n."]);
      continue;
    }
    const chosen = await chooseGrant(request, choice.scope, io, signal);
    if (chosen === "closed") return denial(requestId);
    if (chosen !== "back") {
      return { requestId, decision: choice.decision, rule: chosen.rule };
    }
    io.show(choiceLines(request));
  }
}

/** The terminal channel: allow once, for the session, always, or deny. */
export function createApprovalPromptChannel(
  io: ApprovalPromptIo,
): ApprovalChannel {
  return {
    request: (request, signal) => askOperator(request, io, signal),
  };
}

type ApprovalTerminal = Pick<
  TerminalUi,
  "command" | "prompt" | "setPromptState" | "getPromptOutputStream"
>;

/** The prompt on the CLI's terminal, read a key at a time while a turn runs. */
export function createTerminalApprovalIo(
  ui: ApprovalTerminal,
  input: NodeJS.ReadStream,
): ApprovalPromptIo {
  return {
    show(lines) {
      for (const line of lines) ui.command(line);
    },
    async readLine(promptText, signal) {
      // Tell the retained view a question is open, as the composer does.
      ui.setPromptState(createPromptState({ mode: "menu", promptText }));
      try {
        return await readLineFromKeys(
          { input, output: ui.getPromptOutputStream() },
          ui.prompt(promptText),
          signal,
        );
      } finally {
        ui.setPromptState(null);
      }
    },
  };
}
