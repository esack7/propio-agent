import type { ChatTool } from "@propio-ai/providers";
import type { ToolExecutionResult } from "./types.js";

export interface ToolExecutionContext {
  /** Cooperative cancellation. It cannot roll back completed filesystem changes. */
  readonly signal?: AbortSignal;
}

/** Execution only; a renderer is never required or invoked by the registry. */
export interface ExecutableTool {
  readonly name: string;
  readonly description: string;
  getSchema(): ChatTool;
  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string>;
  /** Optional structured result, used by the registry when supplied (e.g. MCP). */
  executeWithStatus?(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface ToolRegistryOptions {
  /** No callback means no additional policy. Exceptions fail closed. */
  readonly approve?: (
    invocation: {
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    },
    context: ToolExecutionContext,
  ) => boolean | Promise<boolean>;
  /** Called after execution. The consumer owns thresholds, storage and preview formatting. */
  readonly processOutput?: (output: {
    readonly name: string;
    readonly result: Readonly<ToolExecutionResult>;
  }) =>
    | {
        content: string;
        externalStorage?: ToolExecutionResult["externalStorage"];
      }
    | Promise<{
        content: string;
        externalStorage?: ToolExecutionResult["externalStorage"];
      }>;
}
