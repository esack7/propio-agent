import type { ApprovalAnswer, ApprovalRequest } from "../policy/index.js";

/**
 * Puts an approval request to whoever may answer it. Requests and answers are
 * plain JSON, so the other side may be a terminal prompt or another process.
 */
export interface ApprovalChannel {
  request(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalAnswer>;
}
