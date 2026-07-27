import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { ChatTool } from "@propio-ai/providers";
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
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 500;
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

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(createTimeoutError(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      },
    );
  });
}

async function waitBestEffort(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;

  await new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
    promise.then(
      () => {
        completed = true;
        resolve();
      },
      () => {
        completed = true;
        resolve();
      },
    );
  });

  if (timeout) {
    clearTimeout(timeout);
  }

  return completed;
}

type TransportChildProcess = {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
};

function getTransportChildProcess(
  transport: StdioClientTransport | undefined,
): TransportChildProcess | undefined {
  return (transport as unknown as { _process?: TransportChildProcess })
    ?._process;
}

async function closeClientBestEffort(
  client: Client,
  transport: StdioClientTransport | undefined,
): Promise<void> {
  const childProcess = getTransportChildProcess(transport);
  const completed = await waitBestEffort(
    Promise.resolve().then(() => client.close()),
    CLEANUP_TIMEOUT_MS,
  );

  if (!completed && childProcess?.exitCode === null) {
    try {
      childProcess.kill("SIGKILL");
    } catch {
      // Best-effort cleanup only.
    }
  }
}

type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "audio"; mimeType: string; data: string }
  | {
      type: "resource";
      resource:
        | { uri: string; text: string; mimeType?: string }
        | { uri: string; blob: string; mimeType?: string };
    }
  | { type: "resource_link"; uri: string; mimeType?: string };

function formatMcpContentItem(item: McpContentItem): string {
  switch (item.type) {
    case "text":
      return item.text;
    case "image":
    case "audio":
      return `[${item.type} ${item.mimeType}, ${item.data.length} base64 chars]`;
    case "resource":
      return "text" in item.resource
        ? item.resource.text
        : `[resource ${item.resource.uri}]`;
    case "resource_link":
      return `[resource ${item.uri}]`;
  }
}

function formatCallToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const callToolResult = result as {
    content: McpContentItem[];
    structuredContent?: Record<string, unknown>;
  };
  const parts = (callToolResult.content ?? []).map(formatMcpContentItem);

  if (callToolResult.structuredContent !== undefined) {
    parts.push(JSON.stringify(callToolResult.structuredContent, null, 2));
  }

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function createInitialRuntime(
  name: string,
  entry: McpServerConfigEntry,
): McpServerRuntime {
  const enabled = isMcpServerEnabled(entry);
  return {
    name,
    normalizedName: normalizeMcpNameSegment(name),
    config: entry,
    enabled,
    status: enabled ? "pending" : "disabled",
    connectionId: 0,
    remoteTools: [],
    tools: [],
  };
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

interface McpManagerOptions {
  configPath?: string;
  config?: McpConfigFile;
  connectTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

function resolveManagerConfigPath(options?: McpManagerOptions): string {
  return options?.configPath ?? getMcpConfigPath();
}

function resolveManagerConfig(
  configPath: string,
  options?: McpManagerOptions,
): McpConfigFile {
  return options?.config ?? loadMcpConfig(configPath);
}

export class McpManager {
  private readonly configPath: string;
  private config: McpConfigFile;
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectTimeoutMs: number;
  private startupPromise: Promise<void> | null = null;

  constructor(options?: McpManagerOptions) {
    this.configPath = resolveManagerConfigPath(options);
    this.clientName = options?.clientName ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = options?.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.connectTimeoutMs =
      options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.config = resolveManagerConfig(this.configPath, options);

    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      this.runtimes.set(name, createInitialRuntime(name, entry));
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
    const activeTransport = runtime.transport;
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.instructions = undefined;

    if (activeClient) {
      await closeClientBestEffort(activeClient, activeTransport);
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

    const startup = async (): Promise<{
      readonly instructions?: string;
      readonly remoteTools: McpSdkTool[];
      readonly tools: ManagedMcpTool[];
    }> => {
      await client.connect(transport);
      const remoteTools = await this.listAllTools(client);
      const tools = this.createManagedTools(name, remoteTools);
      return {
        instructions: client.getInstructions(),
        remoteTools,
        tools,
      };
    };

    try {
      const result = await withTimeout(
        startup(),
        this.connectTimeoutMs,
        `Timed out after ${this.connectTimeoutMs}ms while starting MCP server "${name}"`,
      );

      if (runtime.connectionId !== connectionId) {
        await closeClientBestEffort(client, transport);
        return;
      }

      runtime.client = client;
      runtime.transport = transport;
      runtime.instructions = result.instructions;
      runtime.remoteTools = result.remoteTools;
      runtime.tools = result.tools;
      runtime.status = "connected";
      runtime.lastError = undefined;
    } catch (error) {
      if (runtime.connectionId !== connectionId) {
        await closeClientBestEffort(client, transport);
        return;
      }

      runtime.connectionId++;
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

      await closeClientBestEffort(client, transport);
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
    const toolName = this.getRemoteToolName(runtime, remoteToolName);
    if (!runtime.enabled || runtime.status !== "connected" || !runtime.client) {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${toolName}`,
      };
    }

    try {
      const result = await runtime.client.callTool({
        name: remoteToolName,
        arguments: args,
      });

      return this.toToolExecutionResult(toolName, result);
    } catch (error) {
      return {
        status: "error",
        content: formatToolCallError(toolName, toErrorMessage(error)),
      };
    }
  }

  private getRemoteToolName(
    runtime: McpServerRuntime,
    remoteToolName: string,
  ): string {
    return (
      runtime.tools.find((tool) => tool.remoteToolName === remoteToolName)
        ?.name ??
      `mcp__${runtime.normalizedName}__${normalizeMcpNameSegment(remoteToolName)}`
    );
  }

  private toToolExecutionResult(
    toolName: string,
    result: Awaited<ReturnType<Client["callTool"]>>,
  ): ToolExecutionResult {
    const content = formatCallToolResult(result);
    return result.isError
      ? {
          status: "error",
          content: formatToolCallError(
            toolName,
            content || "The MCP server reported an error without details.",
          ),
        }
      : {
          status: "success",
          content: content || "Tool completed successfully.",
        };
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
