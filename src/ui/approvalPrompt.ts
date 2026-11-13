import type { ApprovalChannel } from "../permissions/approvalChannel.js";
import type { ApprovalRequest } from "../policy/index.js";

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
      `Command: ${target.command}`,
      ...(args.cwd === undefined ? [] : [`Directory: ${String(args.cwd)}`]),
      ...(args.env === undefined ? [] : [`Environment: ${preview(args.env)}`]),
    ];
  }
  if (target?.kind === "path") return [`Path: ${target.path}`];
  return [`Arguments: ${preview(args)}`];
}

/** The question put to the operator, built only from the request. */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  return [
    `${request.toolName} needs approval.`,
    ...operationLines(request),
    `Reason: ${request.reason}`,
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
