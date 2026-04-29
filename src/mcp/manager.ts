import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { ChatTool } from "../providers/types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import {
  getMcpConfigPath,
  isMcpServerEnabled,
  loadMcpConfig,
  updateMcpServerEnabledInFile,
} from "./config.js";
import { normalizeMcpNameSegment } from "./toolName.js";
import { McpExecutableTool } from "./tool.js";
import type {
  ManagedMcpTool,
  McpConfigFile,
  McpServerConfigEntry,
  McpServerDetail,
  McpServerRuntime,
  McpServerSummary,
  McpToolSummary,
} from "./types.js";

const DEFAULT_CLIENT_NAME = "propio-agent";
const DEFAULT_CLIENT_VERSION = "1.0.0";
const MAX_STDERR_TAIL_CHARS = 4000;

function appendTail(existing: string | undefined, chunk: string): string {
  const next = `${existing ?? ""}${chunk}`;
  return next.length <= MAX_STDERR_TAIL_CHARS
    ? next
    : next.slice(-MAX_STDERR_TAIL_CHARS);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToolCallError(toolName: string, message: string): string {
  return `Error executing ${toolName}: ${message}`;
}

function formatCallToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const callToolResult = result as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; mimeType: string; data: string }
      | { type: "audio"; mimeType: string; data: string }
      | {
          type: "resource";
          resource:
            | { uri: string; text: string; mimeType?: string }
            | { uri: string; blob: string; mimeType?: string };
        }
      | { type: "resource_link"; uri: string; mimeType?: string }
    >;
    structuredContent?: Record<string, unknown>;
  };
  const parts: string[] = [];

  for (const item of callToolResult.content ?? []) {
    switch (item.type) {
      case "text":
        parts.push(item.text);
        break;
      case "image":
        parts.push(
          `[image ${item.mimeType}, ${item.data.length} base64 chars]`,
        );
        break;
      case "audio":
        parts.push(
          `[audio ${item.mimeType}, ${item.data.length} base64 chars]`,
        );
        break;
      case "resource":
        if ("text" in item.resource) {
          parts.push(item.resource.text);
        } else {
          parts.push(`[resource ${item.resource.uri}]`);
        }
        break;
      case "resource_link":
        parts.push(`[resource ${item.uri}]`);
        break;
    }
  }

  if (callToolResult.structuredContent !== undefined) {
    parts.push(JSON.stringify(callToolResult.structuredContent, null, 2));
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function asToolSummary(tool: ManagedMcpTool): McpToolSummary {
  return {
    name: tool.name,
    description: tool.description,
    serverName: tool.serverName,
    remoteToolName: tool.remoteToolName,
    ...(tool.title ? { title: tool.title } : {}),
  };
}

export class McpManager {
  private readonly configPath: string;
  private config: McpConfigFile;
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private startupPromise: Promise<void> | null = null;

  constructor(options?: {
    configPath?: string;
    clientName?: string;
    clientVersion?: string;
  }) {
    this.configPath = options?.configPath ?? getMcpConfigPath();
    this.clientName = options?.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = options?.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.config = loadMcpConfig(this.configPath);

    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      this.runtimes.set(name, {
        name,
        normalizedName: normalizeMcpNameSegment(name),
        config: entry,
        enabled: isMcpServerEnabled(entry),
        status: isMcpServerEnabled(entry) ? "pending" : "disabled",
        connectionId: 0,
        remoteTools: [],
        tools: [],
      });
    }
  }

  async initialize(): Promise<void> {
    if (!this.startupPromise) {
      this.startupPromise = this.connectEnabledServers();
    }
    await this.startupPromise;
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.runtimes.values()).map(async (runtime) => {
        runtime.enabled = false;
        runtime.status = "disabled";
        runtime.remoteTools = [];
        runtime.tools = [];
        runtime.lastError = undefined;
        runtime.connectionId++;
        await this.disposeRuntimeConnection(runtime);
      }),
    );
  }

  private getServerConfig(name: string): McpServerConfigEntry {
    const entry = this.config.mcpServers?.[name];
    if (!entry) {
      throw new Error(`Unknown MCP server: "${name}"`);
    }
    return entry;
  }

  private getRuntime(name: string): McpServerRuntime {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Unknown MCP server: "${name}"`);
    }
    return runtime;
  }

  private async connectEnabledServers(): Promise<void> {
    await Promise.all(
      Object.keys(this.config.mcpServers ?? {}).map(async (name) => {
        const entry = this.config.mcpServers?.[name];
        if (entry && isMcpServerEnabled(entry)) {
          await this.connectServer(name);
        }
      }),
    );
  }

  private async disposeRuntimeConnection(
    runtime: McpServerRuntime,
  ): Promise<void> {
    const activeClient = runtime.client;
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.instructions = undefined;

    if (activeClient) {
      try {
        await activeClient.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private async listAllTools(client: Client): Promise<McpSdkTool[]> {
    const tools: McpSdkTool[] = [];
    let cursor: string | undefined;

    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    return tools;
  }

  private createManagedTools(
    serverName: string,
    remoteTools: McpSdkTool[],
  ): ManagedMcpTool[] {
    const seen = new Map<string, string>();

    return remoteTools.map((remoteTool) => {
      const tool = new McpExecutableTool({
        serverName,
        remoteTool,
        invoke: async (args) => {
          return await this.callRemoteTool(serverName, remoteTool.name, args);
        },
      });

      const previous = seen.get(tool.name);
      if (previous && previous !== remoteTool.name) {
        throw new Error(
          `MCP server "${serverName}" exposed tools "${previous}" and "${remoteTool.name}" that normalize to the same name "${tool.name}"`,
        );
      }
      seen.set(tool.name, remoteTool.name);

      return tool;
    });
  }

  private async connectServer(name: string): Promise<void> {
    const runtime = this.getRuntime(name);
    const config = this.getServerConfig(name);

    runtime.config = config;
    runtime.enabled = isMcpServerEnabled(config);

    await this.disposeRuntimeConnection(runtime);

    runtime.remoteTools = [];
    runtime.tools = [];
    runtime.lastError = undefined;
    runtime.stderrTail = undefined;

    if (!runtime.enabled) {
      runtime.status = "disabled";
      return;
    }

    const connectionId = runtime.connectionId + 1;
    runtime.connectionId = connectionId;
    runtime.status = "pending";

    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      runtime.stderrTail = appendTail(runtime.stderrTail, String(chunk));
    });

    const client = new Client({
      name: this.clientName,
      version: this.clientVersion,
    });
    client.onerror = (error) => {
      if (runtime.connectionId !== connectionId) {
        return;
      }

      runtime.lastError = error.message;
    };
    client.onclose = () => {
      if (runtime.connectionId !== connectionId) {
        return;
      }

      if (!runtime.enabled) {
        runtime.status = "disabled";
        return;
      }

      runtime.status = "failed";
      runtime.lastError =
        runtime.lastError ||
        runtime.stderrTail?.trim() ||
        "MCP connection closed unexpectedly";
      runtime.client = undefined;
      runtime.transport = undefined;
      runtime.instructions = undefined;
      runtime.remoteTools = [];
      runtime.tools = [];
    };

    try {
      await client.connect(transport);
      const remoteTools = await this.listAllTools(client);
      const tools = this.createManagedTools(name, remoteTools);

      if (runtime.connectionId !== connectionId) {
        await client.close();
        return;
      }

      runtime.client = client;
      runtime.transport = transport;
      runtime.instructions = client.getInstructions();
      runtime.remoteTools = remoteTools;
      runtime.tools = tools;
      runtime.status = "connected";
      runtime.lastError = undefined;
    } catch (error) {
      if (runtime.connectionId !== connectionId) {
        try {
          await client.close();
        } catch {
          // Best-effort cleanup only.
        }
        return;
      }

      runtime.client = undefined;
      runtime.transport = undefined;
      runtime.instructions = undefined;
      runtime.remoteTools = [];
      runtime.tools = [];
      runtime.status = "failed";
      const errorMessage = toErrorMessage(error);
      const stderrTail = (
        runtime as {
          stderrTail?: string;
        }
      ).stderrTail?.trim();
      runtime.lastError = stderrTail
        ? `${errorMessage}\n${stderrTail}`
        : errorMessage;

      try {
        await client.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private getRuntimeForTool(name: string): McpServerRuntime | undefined {
    return Array.from(this.runtimes.values()).find((runtime) =>
      runtime.tools.some((tool) => tool.name === name),
    );
  }

  private getToolByName(name: string): ManagedMcpTool | undefined {
    for (const runtime of this.runtimes.values()) {
      const tool = runtime.tools.find((entry) => entry.name === name);
      if (tool) {
        return tool;
      }
    }

    return undefined;
  }

  private getAllTools(): ManagedMcpTool[] {
    return Object.keys(this.config.mcpServers ?? {}).flatMap((name) => {
      return this.runtimes.get(name)?.tools ?? [];
    });
  }

  private async callRemoteTool(
    serverName: string,
    remoteToolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const runtime = this.getRuntime(serverName);
    if (!runtime.enabled || runtime.status !== "connected" || !runtime.client) {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${runtime.tools.find((tool) => tool.remoteToolName === remoteToolName)?.name ?? `mcp__${runtime.normalizedName}__${normalizeMcpNameSegment(remoteToolName)}`}`,
      };
    }

    const toolName =
      runtime.tools.find((tool) => tool.remoteToolName === remoteToolName)
        ?.name ??
      `mcp__${runtime.normalizedName}__${normalizeMcpNameSegment(remoteToolName)}`;

    try {
      const result = await runtime.client.callTool({
        name: remoteToolName,
        arguments: args,
      });

      const content = formatCallToolResult(result);
      if (result.isError) {
        return {
          status: "error",
          content: formatToolCallError(
            toolName,
            content || "The MCP server reported an error without details.",
          ),
        };
      }

      return {
        status: "success",
        content: content || "Tool completed successfully.",
      };
    } catch (error) {
      return {
        status: "error",
        content: formatToolCallError(toolName, toErrorMessage(error)),
      };
    }
  }

  getConnectedToolSchemas(): ChatTool[] {
    const schemas: ChatTool[] = [];
    const seen = new Set<string>();

    for (const runtime of this.runtimes.values()) {
      if (!runtime.enabled || runtime.status !== "connected") {
        continue;
      }

      for (const tool of runtime.tools) {
        const schema = tool.getSchema();
        if (seen.has(schema.function.name)) {
          continue;
        }
        seen.add(schema.function.name);
        schemas.push(schema);
      }
    }

    return schemas;
  }

  describeToolInvocation(
    name: string,
    args: Record<string, unknown>,
  ): string | undefined {
    const tool = this.getToolByName(name);
    return tool?.getInvocationLabel?.(args);
  }

  hasTool(name: string): boolean {
    return this.getToolByName(name) !== undefined;
  }

  async executeToolWithStatus(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const tool = this.getToolByName(name);
    if (!tool) {
      return { status: "tool_not_found", content: `Tool not found: ${name}` };
    }

    const runtime = this.getRuntimeForTool(name);
    if (!runtime || !runtime.enabled || runtime.status !== "connected") {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${name}`,
      };
    }

    return await tool.executeWithStatus(args);
  }

  getServerSummaries(): ReadonlyArray<McpServerSummary> {
    return Object.entries(this.config.mcpServers ?? {}).map(([name, entry]) => {
      const runtime = this.runtimes.get(name);
      return {
        name,
        enabled: runtime?.enabled ?? isMcpServerEnabled(entry),
        status:
          runtime?.status ??
          (isMcpServerEnabled(entry) ? "pending" : "disabled"),
        toolCount: runtime?.tools.length ?? 0,
        ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      };
    });
  }

  getServerDetail(name: string): McpServerDetail | null {
    const config = this.config.mcpServers?.[name];
    const runtime = this.runtimes.get(name);
    if (!config || !runtime) {
      return null;
    }

    return {
      name,
      enabled: runtime.enabled,
      status: runtime.status,
      command: config.command,
      args: [...(config.args ?? [])],
      envKeys: Object.keys(config.env ?? {}),
      ...(runtime.instructions ? { instructions: runtime.instructions } : {}),
      ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
      tools: runtime.tools.map((tool) => asToolSummary(tool)),
    };
  }

  listTools(serverName?: string): ReadonlyArray<McpToolSummary> {
    if (serverName) {
      const runtime = this.runtimes.get(serverName);
      if (!runtime) {
        throw new Error(`Unknown MCP server: "${serverName}"`);
      }

      return runtime.tools.map((tool) => asToolSummary(tool));
    }

    return this.getAllTools().map((tool) => asToolSummary(tool));
  }

  async reconnectServer(name: string): Promise<McpServerSummary> {
    this.getServerConfig(name);
    const runtime = this.getRuntime(name);
    runtime.lastError = undefined;
    await this.connectServer(name);
    return this.getServerSummaries().find((summary) => summary.name === name)!;
  }

  async setServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<McpServerSummary> {
    this.getServerConfig(name);
    this.config = updateMcpServerEnabledInFile(this.configPath, name, enabled);

    const updatedConfig = this.getServerConfig(name);
    const runtime = this.getRuntime(name);
    runtime.config = updatedConfig;
    runtime.enabled = enabled;

    if (enabled) {
      await this.connectServer(name);
    } else {
      runtime.connectionId++;
      runtime.status = "disabled";
      runtime.lastError = undefined;
      await this.disposeRuntimeConnection(runtime);
      runtime.remoteTools = [];
      runtime.tools = [];
    }

    return this.getServerSummaries().find((summary) => summary.name === name)!;
  }
}
