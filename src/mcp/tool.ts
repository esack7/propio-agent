import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { ChatTool } from "../providers/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { buildMcpToolName } from "./toolName.js";
import type { ManagedMcpTool } from "./types.js";

function toToolParameters(
  inputSchema: McpSdkTool["inputSchema"],
): ChatTool["function"]["parameters"] {
  return { ...inputSchema } as ChatTool["function"]["parameters"];
}

export class McpExecutableTool implements ManagedMcpTool {
  readonly name: string;
  readonly description: string;
  readonly serverName: string;
  readonly remoteToolName: string;
  readonly title?: string;
  private readonly schema: ChatTool;
  private readonly invoke: (
    args: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;

  constructor(options: {
    serverName: string;
    remoteTool: McpSdkTool;
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
    this.schema = {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: toToolParameters(options.remoteTool.inputSchema),
      },
    };
    this.invoke = options.invoke;
  }

  getSchema(): ChatTool {
    return this.schema;
  }

  getInvocationLabel(): string {
    return this.title || `${this.serverName}:${this.remoteToolName}`;
  }

  async executeWithStatus(
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    return await this.invoke(args);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const result = await this.executeWithStatus(args);
    if (result.status === "success") {
      return result.content;
    }

    throw new Error(result.content);
  }
}
