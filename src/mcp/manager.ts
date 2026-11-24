import type { ChatTool } from "@propio-ai/providers";
import { McpConnectionManager } from "./connectionManager.js";
import {
  getMcpConfigPath,
  loadMcpConfig,
  updateMcpServerEnabledInFile,
} from "./config.js";
import { McpExecutableTool } from "./tool.js";
import { McpAuthorizationError } from "./oauth.js";
import type { McpCredentialStore } from "./oauth.js";
import type { McpConfigFile, McpServerSummary } from "./types.js";
import type { ToolDisplay } from "../tools/display.js";
import type { ToolExecutionResult } from "../tools/types.js";

import { resolveSettingsLocation } from "../config/permissionStore.js";
import { FileMcpCredentialStore } from "../config/mcpCredentialStore.js";
import { withMcpLogin } from "./login.js";

let activeLogins = 0;

export function isMcpLoginActive(): boolean {
  return activeLogins > 0;
}

interface McpManagerOptions {
  openBrowser?: (url: string) => Promise<void>;
  credentialStore?: McpCredentialStore;
  loginTimeoutMs?: number;
  configPath?: string;
  config?: McpConfigFile;
  connectTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

/** Propio configuration and executable-tool adapter. */
export class McpManager extends McpConnectionManager {
  private readonly credentialStore: McpCredentialStore;
  private readonly openBrowser?: (url: string) => Promise<void>;
  private catalogVersion?: string;
  private adapters = new Map<string, McpExecutableTool>();
  constructor(options: McpManagerOptions = {}) {
    const configPath = options.configPath ?? getMcpConfigPath();
    const config = options.config ?? loadMcpConfig(configPath);
    const credentialStore =
      options.credentialStore ?? new FileMcpCredentialStore();
    super({
      config,
      oauth: {
        owner: "local",
        store: credentialStore,
        clientMetadata: {
          redirect_uris: [],
          client_name: "Propio",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      },
      clientIdentity: {
        name: options.clientName ?? "propio-agent",
        version: options.clientVersion ?? "1.0.0",
      },
      connectTimeoutMs: options.connectTimeoutMs,
      loginTimeoutMs: options.loginTimeoutMs,
      persistConfig: (_updated, change) => {
        updateMcpServerEnabledInFile(
          configPath,
          change.serverName,
          change.enabled,
        );
      },
    });
    this.openBrowser = options.openBrowser;
    this.credentialStore = credentialStore;
  }

  private assertHttpServer(name: string): void {
    if (resolveSettingsLocation().sandbox)
      throw new McpAuthorizationError(
        "MCP login and logout are unavailable in sandbox mode; run /mcp login <server> or /mcp logout <server> on the host",
      );
    const detail = this.getServerDetail(name);
    if (!detail)
      throw new McpAuthorizationError("Unknown MCP server; use /mcp list");
    if (detail.transport !== "streamable-http")
      throw new McpAuthorizationError(
        "Sign-in requires a Streamable HTTP server; use /mcp get <server>",
      );
  }

  override clearServerCredentials(name: string): Promise<void> {
    this.assertHttpServer(name);
    return super.clearServerCredentials(name);
  }

  async loginCliServer(name: string): Promise<McpServerSummary> {
    this.assertHttpServer(name);
    if (!process.stdin.isTTY)
      throw new McpAuthorizationError(
        "Sign-in requires an interactive terminal; run /mcp login <server> interactively",
      );
    if (this.credentialStore instanceof FileMcpCredentialStore)
      await this.credentialStore.assertAvailable();
    const controller = new AbortController();
    activeLogins++;
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    try {
      return await withMcpLogin(
        (interaction, signal) => this.loginServer(name, interaction, signal),
        this.openBrowser,
        controller.signal,
      );
    } finally {
      activeLogins--;
      process.removeListener("SIGINT", cancel);
    }
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
            validateArguments: (args) =>
              this.validateToolArguments(tool.name, args),
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

  /** How to show a call to one of this manager's tools, if it has that tool. */
  describeCall(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): ToolDisplay | undefined {
    return this.getExecutableTools().get(name)?.describeCall(args);
  }

  describeResult(
    name: string,
    args: Readonly<Record<string, unknown>>,
    result: Readonly<ToolExecutionResult>,
  ): ToolDisplay | undefined {
    return this.getExecutableTools().get(name)?.describeResult(args, result);
  }
}
