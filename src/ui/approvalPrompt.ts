import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalRequest } from "../policy/index.js";
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
