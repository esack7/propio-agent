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

export function validateMcpConfig(config: unknown): McpConfigFile {
  const rawServers = getRawMcpServers(config);
  const normalizedNames = new Map<string, string>();
  const validatedServers = Object.fromEntries(
    Object.entries(rawServers).map(([serverName, rawEntry]) => [
      serverName,
      validateMcpServerConfig(serverName, rawEntry, normalizedNames),
    ]),
  );

  return { mcpServers: validatedServers };
}

function getRawMcpServers(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    throw new Error("MCP configuration root must be a JSON object");
  }

  const rawServers = config.mcpServers;
  if (rawServers === undefined) {
    return {};
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

  validateUniqueMcpServerName(serverName, normalizedNames);
  if (rawEntry.transport === "streamable-http") {
    return validateHttpEntry(serverName, rawEntry);
  }
  validateMcpServerTransport(serverName, rawEntry);
  validateMcpServerFields(serverName, rawEntry);

  return {
    ...(rawEntry.transport === "stdio" ? { transport: "stdio" as const } : {}),
    command: rawEntry.command!.trim(),
    ...(rawEntry.args ? { args: [...rawEntry.args] } : {}),
    ...(rawEntry.env ? { env: { ...rawEntry.env } } : {}),
    ...(rawEntry.enabled !== undefined ? { enabled: rawEntry.enabled } : {}),
  };
}

function validateMcpServerTransport(
  serverName: string,
  rawEntry: Record<string, unknown>,
): void {
  if (rawEntry.transport !== undefined && rawEntry.transport !== "stdio") {
    throw new Error(`MCP server "${serverName}" has an unsupported transport`);
  }
  if ("tools" in rawEntry)
    throw new Error("MCP tool filters are not supported yet");
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

export function isMcpServerEnabled(entry: McpServerConfigEntry): boolean {
  return entry.enabled !== false;
}

function validateHttpEntry(
  serverName: string,
  entry: Record<string, unknown>,
): McpServerConfigEntry {
  const invalid = () =>
    new Error(
      `MCP server "${serverName}" requires a credential-free HTTPS URL (HTTP is allowed on loopback) and no stdio fields or tool filters`,
    );
  if (
    ["command", "args", "env", "http", "sse", "ws", "tools"].some(
      (key) => key in entry,
    )
  )
    throw invalid();
  if (typeof entry.url !== "string") throw invalid();
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    throw invalid();
  }
  if (!isAllowedEndpoint(url)) throw invalid();
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
    throw invalid();
  return {
    transport: "streamable-http",
    url: url.href,
    ...(entry.enabled !== undefined
      ? { enabled: entry.enabled as boolean }
      : {}),
  };
}

function isAllowedEndpoint(url: URL): boolean {
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  return (
    ["localhost", "[::1]"].includes(hostname) ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}
