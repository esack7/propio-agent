import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutableTool } from "../tools/interface.js";

export interface McpServerConfigEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
}

export interface McpConfigFile {
  readonly mcpServers?: Record<string, McpServerConfigEntry>;
}

export type McpServerStatus = "disabled" | "pending" | "connected" | "failed";

export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
  readonly serverName: string;
  readonly remoteToolName: string;
  readonly title?: string;
}

export interface McpServerSummary {
  readonly name: string;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly lastError?: string;
}

export interface McpServerDetail {
  readonly name: string;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly command: string;
  readonly args: readonly string[];
  readonly envKeys: readonly string[];
  readonly instructions?: string;
  readonly lastError?: string;
  readonly tools: ReadonlyArray<McpToolSummary>;
}

export interface ManagedMcpTool extends ExecutableTool {
  readonly serverName: string;
  readonly remoteToolName: string;
  readonly title?: string;
  executeWithStatus(
    args: Record<string, unknown>,
  ): Promise<import("../tools/types.js").ToolExecutionResult>;
}

export interface McpServerRuntime {
  readonly name: string;
  readonly normalizedName: string;
  config: McpServerConfigEntry;
  enabled: boolean;
  status: McpServerStatus;
  connectionId: number;
  lastError?: string;
  instructions?: string;
  stderrTail?: string;
  client?: Client;
  transport?: StdioClientTransport;
  remoteTools: McpSdkTool[];
  tools: ManagedMcpTool[];
}
