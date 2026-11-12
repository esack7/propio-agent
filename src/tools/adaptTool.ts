import type { ChatTool } from "@propio-ai/providers";
import type { ExecutableTool, ToolExecutionContext } from "./execution.js";
import type { ToolExecutionResult } from "./types.js";

/** Adapt a caller-owned integration (including MCP) without importing its runtime. */
export function createExecutableTool(options: {
  schema: ChatTool;
  invoke: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>;
  /** Replaces the registry's schema check; see ExecutableTool.validateArguments. */
  validateArguments?: ExecutableTool["validateArguments"];
  /** Omit for a tool with unknown external effects, such as an MCP tool. */
  metadata?: ExecutableTool["metadata"];
}): ExecutableTool & Required<Pick<ExecutableTool, "executeWithStatus">> {
  const schema = structuredClone(options.schema);
  const invoke = options.invoke;
  const executeWithStatus = async (
    args: Record<string, unknown>,
    context: ToolExecutionContext = {},
  ) => {
    context.signal?.throwIfAborted();
    return invoke(args, context);
  };
  return {
    name: schema.function.name,
    description: schema.function.description ?? "",
    getSchema: () => structuredClone(schema),
    executeWithStatus,
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.validateArguments
      ? { validateArguments: options.validateArguments }
      : {}),
    async execute(args, context) {
      const result = await executeWithStatus(args, context);
      if (result.status !== "success") throw new Error(result.content);
      return result.content;
    },
  };
}
