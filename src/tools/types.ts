export type ToolExecutionStatus =
  | "success"
  | "tool_not_found"
  | "tool_disabled"
  | "error";

export interface ToolExecutionResult {
  status: ToolExecutionStatus;
  content: string;
}
