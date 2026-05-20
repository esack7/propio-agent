import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readJsonFile,
  readJsonFileAsync,
  writeJsonFileAtomic,
} from "../config/jsonFile.js";
import { normalizeMcpNameSegment } from "./toolName.js";
import type { McpConfigFile, McpServerConfigEntry } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function getMcpConfigPath(): string {
  const dockerConfigPath = "/app/.propio/mcp.json";
  if (fs.existsSync(dockerConfigPath)) {
    return dockerConfigPath;
  }

  return path.join(os.homedir(), ".propio", "mcp.json");
}

export function isMcpServerEnabled(entry: McpServerConfigEntry): boolean {
  return entry.enabled !== false;
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

export function validateMcpConfig(config: unknown): McpConfigFile {
  const rawServers = getRawMcpServers(config);
  const normalizedNames = new Map<string, string>();
  const validatedServers: Record<string, McpServerConfigEntry> = {};

  for (const [serverName, rawEntry] of Object.entries(rawServers)) {
    validatedServers[serverName] = validateMcpServerConfig(
      serverName,
      rawEntry,
      normalizedNames,
    );
  }

  return { mcpServers: validatedServers };
}

function getRawMcpServers(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    throw new Error("MCP configuration root must be a JSON object");
  }

  const rawServers = config.mcpServers;
  if (rawServers === undefined) {
    return { mcpServers: {} };
  }

  if (!isPlainObject(rawServers)) {
    throw new Error('MCP configuration field "mcpServers" must be an object');
  }

  return rawServers;
}

function validateMcpServerConfig(
  serverName: string,
  rawEntry: unknown,
  normalizedNames: Map<string, string>,
): McpServerConfigEntry {
  if (!isPlainObject(rawEntry)) {
    throw new Error(`MCP server "${serverName}" must be an object`);
  }

  validateMcpServerTransport(serverName, rawEntry);
  validateMcpServerFields(serverName, rawEntry);
  validateUniqueMcpServerName(serverName, normalizedNames);

  return {
    command: rawEntry.command.trim(),
    ...(rawEntry.args ? { args: [...rawEntry.args] } : {}),
    ...(rawEntry.env ? { env: { ...rawEntry.env } } : {}),
    ...(rawEntry.enabled !== undefined ? { enabled: rawEntry.enabled } : {}),
  };
}

function validateMcpServerTransport(
  serverName: string,
  rawEntry: Record<string, unknown>,
): void {
  const unsupportedFields = ["url", "http", "sse", "ws"].filter(
    (field) => field in rawEntry,
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `MCP server "${serverName}" uses ${unsupportedFields.join(", ")}, which is not yet supported in v1. Only stdio servers are supported.`,
    );
  }
}

function validateMcpServerFields(
  serverName: string,
  rawEntry: Record<string, unknown>,
): asserts rawEntry is Record<string, unknown> & McpServerConfigEntry {
  if (!isNonEmptyString(rawEntry.command)) {
    throw new Error(
      `MCP server "${serverName}" must define a non-empty "command"`,
    );
  }

  if (rawEntry.args !== undefined && !isStringArray(rawEntry.args)) {
    throw new Error(
      `MCP server "${serverName}" field "args" must be an array of non-empty strings`,
    );
  }

  if (rawEntry.env !== undefined && !isStringRecord(rawEntry.env)) {
    throw new Error(
      `MCP server "${serverName}" field "env" must be an object with string values`,
    );
  }

  if (rawEntry.enabled !== undefined && typeof rawEntry.enabled !== "boolean") {
    throw new Error(
      `MCP server "${serverName}" field "enabled" must be a boolean`,
    );
  }
}

function validateUniqueMcpServerName(
  serverName: string,
  normalizedNames: Map<string, string>,
): void {
  const normalizedName = normalizeMcpNameSegment(serverName);
  const existing = normalizedNames.get(normalizedName);
  if (existing && existing !== serverName) {
    throw new Error(
      `MCP server names "${existing}" and "${serverName}" normalize to the same identifier "${normalizedName}"`,
    );
  }
  normalizedNames.set(normalizedName, serverName);
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
