import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  let fileContent: string;

  try {
    fileContent = fs.readFileSync(filePath, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { mcpServers: {} };
    }

    throw new Error(`Failed to read MCP config file: ${error.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch (error: any) {
    throw new Error(`Invalid JSON in MCP config file: ${error.message}`);
  }

  return validateMcpConfig(parsed);
}

export async function loadMcpConfigAsync(
  filePath: string,
): Promise<McpConfigFile> {
  let fileContent: string;

  try {
    fileContent = await fs.promises.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { mcpServers: {} };
    }

    throw new Error(`Failed to read MCP config file: ${error.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch (error: any) {
    throw new Error(`Invalid JSON in MCP config file: ${error.message}`);
  }

  return validateMcpConfig(parsed);
}

export function validateMcpConfig(config: unknown): McpConfigFile {
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

  const normalizedNames = new Map<string, string>();
  const validatedServers: Record<string, McpServerConfigEntry> = {};

  for (const [serverName, rawEntry] of Object.entries(rawServers)) {
    if (!isPlainObject(rawEntry)) {
      throw new Error(`MCP server "${serverName}" must be an object`);
    }

    const unsupportedFields = ["url", "http", "sse", "ws"].filter(
      (field) => field in rawEntry,
    );
    if (unsupportedFields.length > 0) {
      throw new Error(
        `MCP server "${serverName}" uses ${unsupportedFields.join(", ")}, which is not yet supported in v1. Only stdio servers are supported.`,
      );
    }

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

    if (
      rawEntry.enabled !== undefined &&
      typeof rawEntry.enabled !== "boolean"
    ) {
      throw new Error(
        `MCP server "${serverName}" field "enabled" must be a boolean`,
      );
    }

    const normalizedName = normalizeMcpNameSegment(serverName);
    const existing = normalizedNames.get(normalizedName);
    if (existing && existing !== serverName) {
      throw new Error(
        `MCP server names "${existing}" and "${serverName}" normalize to the same identifier "${normalizedName}"`,
      );
    }
    normalizedNames.set(normalizedName, serverName);

    validatedServers[serverName] = {
      command: rawEntry.command.trim(),
      ...(rawEntry.args ? { args: [...rawEntry.args] } : {}),
      ...(rawEntry.env ? { env: { ...rawEntry.env } } : {}),
      ...(rawEntry.enabled !== undefined ? { enabled: rawEntry.enabled } : {}),
    };
  }

  return { mcpServers: validatedServers };
}

export function writeMcpConfig(filePath: string, config: McpConfigFile): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempFilePath = path.join(
    directory,
    `.mcp.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fs.writeFileSync(tempFilePath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
    });
    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempFilePath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
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
