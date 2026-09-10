import type { McpToolDescriptor } from "./types.js";
import type { PresentedTool } from "../tools/interface.js";
import { createExecutableTool } from "../tools/adaptTool.js";
import type { ToolExecutionContext } from "../tools/execution.js";
import type { ChatTool } from "@propio-ai/providers";
import type { ToolExecutionResult } from "../tools/types.js";
import { buildMcpToolName } from "./toolName.js";

function toToolParameters(
  inputSchema: McpToolDescriptor["inputSchema"],
): ChatTool["function"]["parameters"] {
  return { ...inputSchema } as ChatTool["function"]["parameters"];
}

export class McpExecutableTool implements PresentedTool {
  readonly name: string;
  readonly description: string;
  readonly serverName: string;
  readonly remoteToolName: string;
  readonly title?: string;
  private readonly execution: ReturnType<typeof createExecutableTool>;

  constructor(options: {
    serverName: string;
    remoteTool: {
      name: string;
      description?: string;
      title?: string;
      inputSchema: McpToolDescriptor["inputSchema"];
    };
    invoke: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
  }) {
    this.serverName = options.serverName;
    this.remoteToolName = options.remoteTool.name;
    this.title = options.remoteTool.title;
    this.name = buildMcpToolName(this.serverName, this.remoteToolName);
    this.description =
      options.remoteTool.description?.trim() ||
      options.remoteTool.title?.trim() ||
      `MCP tool ${options.remoteTool.name}`;
    const schema: ChatTool = {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: toToolParameters(options.remoteTool.inputSchema),
      },
    };
    this.execution = createExecutableTool({
      schema,
      invoke: options.invoke,
    });
  }

  getSchema(): ChatTool {
    return this.execution.getSchema();
  }

  getInvocationLabel(): string {
    return this.title || `${this.serverName}:${this.remoteToolName}`;
  }

  async executeWithStatus(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    return await this.execution.executeWithStatus(args, context);
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return this.execution.execute(args, context);
  }
}
