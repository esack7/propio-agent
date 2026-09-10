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

  private getExecutableTools(): McpExecutableTool[] {
    return this.getServerSummaries()
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
  }

  getConnectedToolSchemas(): ChatTool[] {
    return this.getExecutableTools().map((tool) => tool.getSchema());
  }

  describeToolInvocation(
    name: string,
    _args: Record<string, unknown>,
  ): string | undefined {
    return this.getExecutableTools()
      .find((tool) => tool.name === name)
      ?.getInvocationLabel();
  }
}
