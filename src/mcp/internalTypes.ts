import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerConfigEntry,
  McpServerStatus,
  McpToolDescriptor,
} from "./types.js";
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
  transport?: Transport;
  remoteTools: McpSdkTool[];
  tools: McpToolDescriptor[];
}
