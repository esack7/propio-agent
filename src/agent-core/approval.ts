import type { ApprovalRequest as PolicyApprovalRequest } from "../policy/index.js";
import type { ToolDisplay } from "../tools/display.js";

/** Application approval envelope; the policy engine does not inspect the preview. */
export interface ApprovalRequest extends PolicyApprovalRequest {
  readonly display?: ToolDisplay;
}
