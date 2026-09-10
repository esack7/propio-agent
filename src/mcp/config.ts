import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readJsonFile,
  readJsonFileAsync,
  writeJsonFileAtomic,
} from "../config/jsonFile.js";
import { validateMcpConfig } from "./validation.js";
export { validateMcpConfig, isMcpServerEnabled } from "./validation.js";
import type { McpConfigFile } from "./types.js";

export function getMcpConfigPath(): string {
  const dockerConfigPath = "/app/.propio/mcp.json";
  if (fs.existsSync(dockerConfigPath)) {
    return dockerConfigPath;
  }

  return path.join(os.homedir(), ".propio", "mcp.json");
}

export function loadMcpConfig(filePath: string): McpConfigFile {
  return validateMcpConfig(readMcpConfigJson(filePath));
}

export async function loadMcpConfigAsync(
  filePath: string,
): Promise<McpConfigFile> {
  return validateMcpConfig(await readMcpConfigJsonAsync(filePath));
}

function readMcpConfigJson(filePath: string): unknown {
  return readJsonFile(filePath, {
    invalidJsonPrefix: "Invalid JSON in MCP config file",
    onMissing: () => ({ mcpServers: {} }),
    readErrorPrefix: "Failed to read MCP config file",
  });
}

async function readMcpConfigJsonAsync(filePath: string): Promise<unknown> {
  return readJsonFileAsync(filePath, {
    invalidJsonPrefix: "Invalid JSON in MCP config file",
    onMissing: () => ({ mcpServers: {} }),
    readErrorPrefix: "Failed to read MCP config file",
  });
}

export function writeMcpConfig(filePath: string, config: McpConfigFile): void {
  writeJsonFileAtomic(filePath, "mcp", config);
}

export function updateMcpServerEnabledInFile(
  filePath: string,
  serverName: string,
  enabled: boolean,
): McpConfigFile {
  const config = loadMcpConfig(filePath);
  const servers = config.mcpServers ?? {};
  const server = servers[serverName];

  if (!server) {
    throw new Error(`Unknown MCP server: "${serverName}"`);
  }

  const updatedConfig = validateMcpConfig({
    mcpServers: {
      ...servers,
      [serverName]: {
        ...server,
        enabled,
      },
    },
  });

  writeMcpConfig(filePath, updatedConfig);
  return updatedConfig;
}
