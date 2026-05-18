export type ToolCallStatus = "running" | "success" | "error";

export interface ToolCallView {
  readonly id: string;
  readonly toolName: string;
  readonly status: ToolCallStatus;
  readonly useLabel: string;
  readonly resultLabel: string | null;
}
