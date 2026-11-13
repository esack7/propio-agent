import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalRequest } from "../policy/index.js";

const ARGUMENT_PREVIEW_LIMIT = 400;

/**
 * Characters that can change what a terminal shows rather than being shown:
 * C0 and C1 controls and DEL (escape sequences, carriage returns, backspace),
 * and invisible or direction-changing formatting characters.
 */
const HIDDEN_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Render untrusted text so the operator sees every character: a hidden one
 * becomes a visible escape such as `\x1b` or `\u202e`. Backslashes are
 * doubled first, so text that already reads `\x1b` cannot pass for one.
 */
export function visibleText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(HIDDEN_CHARACTER, (character) => {
    const named = NAMED_ESCAPES[character];
    if (named) return named;
    const code = character.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

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
 * The question put to the operator, built only from the request. Every field
 * that came from the model, a tool, or a settings file is passed through
 * `visibleText` before it reaches the terminal.
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  return [
    `${visibleText(request.toolName)} needs approval.`,
    ...operationLines(request),
    `Reason: ${visibleText(request.reason)}`,
    "",
    "Allow this call? (y/N) ",
  ].join("\n");
}

/**
 * A minimal terminal channel: allow this one call, or deny it. Anything but
 * an explicit yes, including a closed or cancelled prompt, is a denial.
 */
export function createConfirmApprovalChannel(
  confirm: (promptText: string, signal?: AbortSignal) => Promise<boolean>,
): ApprovalChannel {
  return {
    async request(request, signal) {
      const approved = await confirm(formatApprovalPrompt(request), signal);
      return approved
        ? { requestId: request.id, decision: "allow_once" }
        : { requestId: request.id, decision: "deny" };
    },
  };
}
