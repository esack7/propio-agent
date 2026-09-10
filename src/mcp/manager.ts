import type { ChatTool } from "@propio-ai/providers";
import { McpConnectionManager } from "./connectionManager.js";
import {
  getMcpConfigPath,
  loadMcpConfig,
  updateMcpServerEnabledInFile,
} from "./config.js";
import { McpExecutableTool } from "./tool.js";
import type { McpConfigFile } from "./types.js";

interface McpManagerOptions {
  configPath?: string;
  config?: McpConfigFile;
  connectTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

/** Propio configuration and executable-tool adapter. */
export class McpManager extends McpConnectionManager {
  private catalogVersion?: string;
  private adapters = new Map<string, McpExecutableTool>();
  constructor(options: McpManagerOptions = {}) {
    const configPath = options.configPath ?? getMcpConfigPath();
    const config = options.config ?? loadMcpConfig(configPath);
    super({
      config,
      clientIdentity: {
        name: options.clientName ?? "propio-agent",
        version: options.clientVersion ?? "1.0.0",
      },
      connectTimeoutMs: options.connectTimeoutMs,
      persistConfig: (_updated, change) => {
        updateMcpServerEnabledInFile(
          configPath,
          change.serverName,
          change.enabled,
        );
      },
    });
  }

  private getExecutableTools(): Map<string, McpExecutableTool> {
    const version = this.getToolCatalogVersion();
    if (version === this.catalogVersion) return this.adapters;
    const tools = this.getServerSummaries()
      .filter((server) => server.enabled && server.status === "connected")
      .flatMap((server) => this.listTools(server.name))
      .map(
        (tool) =>
          new McpExecutableTool({
            serverName: tool.serverName,
            remoteTool: {
              name: tool.remoteToolName,
              description: tool.description,
              title: tool.title,
              inputSchema: tool.inputSchema,
            },
            invoke: (args) => this.executeToolWithStatus(tool.name, args),
          }),
      );
    this.adapters = new Map(tools.map((tool) => [tool.name, tool]));
    this.catalogVersion = version;
    return this.adapters;
  }

  getConnectedToolSchemas(): ChatTool[] {
    return Array.from(this.getExecutableTools().values(), (tool) =>
      tool.getSchema(),
    );
  }

  describeToolInvocation(
    name: string,
    _args: Record<string, unknown>,
  ): string | undefined {
    return this.getExecutableTools().get(name)?.getInvocationLabel();
  }
}
