export type ToolExecutionStatus =
  "success" | "tool_not_found" | "tool_disabled" | "error";

export interface ToolExecutionResult {
  status: ToolExecutionStatus;
  content: string;
  externalStorage?: {
    externalPath: string;
    externalSizeBytes: number;
    externalLineCount?: number;
  };
  /** Execution completed but the consumer's output handler failed. Do not retry the tool. */
  outputPersistenceError?: string;
}
