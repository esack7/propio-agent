import { closeClientBestEffort } from "./cleanup.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import { isMcpServerEnabled, validateMcpConfig } from "./validation.js";
import { buildMcpToolName, normalizeMcpNameSegment } from "./toolName.js";
import type { McpServerRuntime } from "./internalTypes.js";
import type {
  McpToolDescriptor,
  McpToolResult,
  McpConnectionOptions,
  McpConfigFile,
  McpServerConfigEntry,
  McpServerDetail,
  McpServerSummary,
} from "./types.js";

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

function positiveTimeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > 2_147_483_647) {
    throw new Error(
      "MCP timeouts must be positive finite milliseconds within the timer range",
    );
  }
  return result;
}

export class McpConnectionManager {
  private config: McpConfigFile;
  private readonly runtimes = new Map<string, McpServerRuntime>();
  private readonly clientIdentity: { name: string; version: string };
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly persistConfig?: McpConnectionOptions["persistConfig"];
  private startupPromise: Promise<void> | null = null;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(options: McpConnectionOptions) {
    this.config = validateMcpConfig(options.config);
    if (
      !options.clientIdentity.name.trim() ||
      !options.clientIdentity.version.trim()
    ) {
      throw new Error("MCP client identity requires a name and version");
    }
    this.clientIdentity = { ...options.clientIdentity };
    this.connectTimeoutMs = positiveTimeout(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.callTimeoutMs = positiveTimeout(options.callTimeoutMs, 60_000);
    this.cleanupTimeoutMs = positiveTimeout(
      options.cleanupTimeoutMs,
      CLEANUP_TIMEOUT_MS,
    );
    this.persistConfig = options.persistConfig;
    for (const [name, entry] of Object.entries(this.config.mcpServers ?? {})) {
      this.runtimes.set(name, createInitialRuntime(name, entry));
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MCP manager is closed");
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    if (!this.startupPromise) {
      this.startupPromise = this.connectEnabledServers();
    }
    await this.startupPromise;
  }

  close(): Promise<void> {
    this.closed = true;
    this.shutdownPromise ??= Promise.all(
      Array.from(this.runtimes.values()).map(async (runtime) => {
        runtime.enabled = false;
        runtime.status = "disabled";
        runtime.remoteTools = [];
        runtime.tools = [];
        runtime.lastError = undefined;
        runtime.connectionId++;
        await this.disposeRuntimeConnection(runtime);
      }),
    ).then(() => {});
    return this.shutdownPromise;
  }

  private getServerConfig(name: string): McpServerConfigEntry {
    const entry = this.config.mcpServers?.[name];
    if (!this.runtimes.has(name) || !entry) {
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
      await closeClientBestEffort(
        activeClient,
        activeTransport,
        this.cleanupTimeoutMs,
      );
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
  ): McpToolDescriptor[] {
    const seen = new Map<string, string>();

    return remoteTools.flatMap((remoteTool) => {
      const tool: McpToolDescriptor = {
        name: buildMcpToolName(serverName, remoteTool.name),
        serverName,
        remoteToolName: remoteTool.name,
        description:
          remoteTool.description?.trim() ||
          remoteTool.title?.trim() ||
          `MCP tool ${remoteTool.name}`,
        ...(remoteTool.title ? { title: remoteTool.title } : {}),
        inputSchema: structuredClone(remoteTool.inputSchema),
      };

      const previous = seen.get(tool.name);
      if (previous === remoteTool.name) return [];
      if (previous !== undefined) {
        throw new Error(
          `MCP server "${serverName}" exposed tools "${previous}" and "${remoteTool.name}" that normalize to the same name "${tool.name}"`,
        );
      }
      seen.set(tool.name, remoteTool.name);

      return [tool];
    });
  }

  private createConnection(
    runtime: McpServerRuntime,
    config: McpServerConfigEntry,
    connectionId: number,
  ): { client: Client; transport: StdioClientTransport } {
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      if (runtime.connectionId === connectionId) {
        runtime.stderrTail = appendTail(runtime.stderrTail, String(chunk));
      }
    });

    const client = new Client(this.clientIdentity);
    runtime.client = client;
    runtime.transport = transport;
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

      runtime.connectionId++;
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

    return { client, transport };
  }

  private async connectServer(name: string): Promise<void> {
    const runtime = this.getRuntime(name);
    const config = this.getServerConfig(name);

    runtime.config = config;
    runtime.enabled = isMcpServerEnabled(config);

    const connectionId = ++runtime.connectionId;
    await this.disposeRuntimeConnection(runtime);
    if (runtime.connectionId !== connectionId || this.closed) return;

    runtime.remoteTools = [];
    runtime.tools = [];
    runtime.lastError = undefined;
    runtime.stderrTail = undefined;

    if (!runtime.enabled) {
      runtime.status = "disabled";
      return;
    }

    runtime.status = "pending";

    const { client, transport } = this.createConnection(
      runtime,
      config,
      connectionId,
    );

    const startup = async (): Promise<{
      readonly instructions?: string;
      readonly remoteTools: McpSdkTool[];
      readonly tools: McpToolDescriptor[];
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
        await closeClientBestEffort(client, transport, this.cleanupTimeoutMs);
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
        await closeClientBestEffort(client, transport, this.cleanupTimeoutMs);
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

      await closeClientBestEffort(client, transport, this.cleanupTimeoutMs);
    }
  }

  private getRuntimeForTool(name: string): McpServerRuntime | undefined {
    return Array.from(this.runtimes.values()).find((runtime) =>
      runtime.tools.some((tool) => tool.name === name),
    );
  }

  private getToolByName(name: string): McpToolDescriptor | undefined {
    for (const runtime of this.runtimes.values()) {
      const tool = runtime.tools.find((entry) => entry.name === name);
      if (tool) {
        return tool;
      }
    }

    return undefined;
  }

  /** Cheap invalidation key for application adapters; contains no SDK objects. */
  protected getToolCatalogVersion(): string {
    return JSON.stringify(
      Array.from(this.runtimes.values(), (runtime) => [
        runtime.name,
        runtime.connectionId,
        runtime.enabled,
        runtime.status,
      ]),
    );
  }

  private getAllTools(): McpToolDescriptor[] {
    return Object.keys(this.config.mcpServers ?? {}).flatMap((name) => {
      return this.runtimes.get(name)?.tools ?? [];
    });
  }

  private async callRemoteTool(
    serverName: string,
    remoteToolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const runtime = this.getRuntime(serverName);
    const toolName = this.getRemoteToolName(runtime, remoteToolName);
    if (!runtime.enabled || runtime.status !== "connected" || !runtime.client) {
      return {
        status: "tool_disabled",
        content: `Tool not available: ${toolName}`,
      };
    }

    try {
      const result = await runtime.client.callTool(
        {
          name: remoteToolName,
          arguments: args,
        },
        undefined,
        { timeout: this.callTimeoutMs },
      );

      return this.toMcpToolResult(toolName, result);
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

  private toMcpToolResult(
    toolName: string,
    result: Awaited<ReturnType<Client["callTool"]>>,
  ): McpToolResult {
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

  hasTool(name: string): boolean {
    return this.getToolByName(name) !== undefined;
  }

  async executeToolWithStatus(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
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

    return await this.callRemoteTool(
      tool.serverName,
      tool.remoteToolName,
      args,
    );
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
      tools: structuredClone(runtime.tools),
    };
  }

  listTools(serverName?: string): ReadonlyArray<McpToolDescriptor> {
    if (serverName) {
      const runtime = this.runtimes.get(serverName);
      if (!runtime) {
        throw new Error(`Unknown MCP server: "${serverName}"`);
      }

      return structuredClone(runtime.tools);
    }

    return structuredClone(this.getAllTools());
  }

  async reconnectServer(name: string): Promise<McpServerSummary> {
    this.assertOpen();
    this.getServerConfig(name);
    const runtime = this.getRuntime(name);
    runtime.lastError = undefined;
    await this.connectServer(name);
    return this.getServerSummaries().find((summary) => summary.name === name)!;
  }

  setServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary> {
    const operation = this.mutation.then(() =>
      this.updateServerEnabled(name, enabled),
    );
    this.mutation = operation.catch(() => {});
    return operation;
  }

  private async updateServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<McpServerSummary> {
    this.getServerConfig(name);
    this.assertOpen();
    const config = validateMcpConfig({
      mcpServers: {
        ...this.config.mcpServers,
        [name]: { ...this.getServerConfig(name), enabled },
      },
    });
    await this.persistConfig?.(structuredClone(config), {
      serverName: name,
      enabled,
    });
    this.config = config;
    // A successful durable write remains successful even if shutdown won the race.
    if (this.closed)
      return this.getServerSummaries().find(
        (summary) => summary.name === name,
      )!;

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
