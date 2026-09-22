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

export interface McpToolDescriptor extends McpToolSummary {
  readonly inputSchema: { type: "object"; [key: string]: unknown };
}

export interface McpCallOutcome {
  readonly kind: "mcp_call";
  readonly classification:
    "succeeded" | "remote_error" | "timed_out" | "transport_error";
  readonly serverName: string;
  readonly remoteToolName: string;
  readonly timeoutMs: number;
  readonly durationMs: number;
  readonly completion: "confirmed" | "not_started" | "unknown";
  readonly sideEffect: "none" | "unknown";
  readonly protocolErrorCode?: number;
}

/** Text representation; media are described rather than decoded. */
export interface McpToolResult {
  status: "success" | "tool_not_found" | "tool_disabled" | "error";
  content: string;
  outcome?: McpCallOutcome;
}

export interface McpConnectionOptions {
  config: McpConfigFile;
  clientIdentity: { name: string; version: string };
  /** Total connection and discovery deadline; default 10 seconds. */
  connectTimeoutMs?: number;
  /** Tool request deadline; default 60 seconds (SDK default). */
  callTimeoutMs?: number;
  /** Grace before forcefully terminating the direct child; default 500 ms. */
  cleanupTimeoutMs?: number;
  /** Awaited before changing runtime state. Omit for in-memory changes only. */
  persistConfig?: (
    config: McpConfigFile,
    change: { readonly serverName: string; readonly enabled: boolean },
  ) => void | Promise<void>;
}
