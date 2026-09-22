export type ToolExecutionStatus =
  "success" | "tool_not_found" | "tool_disabled" | "error";

export type CommandOutcomeClassification =
  | "succeeded"
  | "nonzero_exit"
  | "timed_out"
  | "cancelled"
  | "launch_failed"
  | "output_limit";

export type ToolExecutionOutcome =
  | {
      readonly kind: "command";
      readonly classification: CommandOutcomeClassification;
      readonly exitCode: number;
      readonly terminationSignal?: string;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly durationMs: number;
      readonly environmentKeys: ReadonlyArray<string>;
      readonly outputDiscarded: boolean;
      readonly sideEffect: "unknown";
    }
  | {
      readonly kind: "file_write" | "file_edit";
      readonly classification: "succeeded";
      readonly resolvedPath: string;
      readonly operation: "create" | "replace";
      readonly beforeHash?: string;
      readonly afterHash: string;
      readonly sideEffect: "completed";
    };

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
  /** Structured execution evidence. Legacy status semantics remain unchanged. */
  outcome?: ToolExecutionOutcome;
}
