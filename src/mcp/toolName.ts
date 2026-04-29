import { createHash } from "node:crypto";

function trimUnderscores(value: string): string {
  return value.replace(/^_+|_+$/g, "");
}

export function normalizeMcpNameSegment(value: string): string {
  const normalized = trimUnderscores(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_"),
  );

  return normalized.length > 0 ? normalized : "unnamed";
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const normalizedServerName = normalizeMcpNameSegment(serverName);
  const normalizedToolName = normalizeMcpNameSegment(toolName);
  const unboundedName = `mcp__${normalizedServerName}__${normalizedToolName}`;
  const maxLength = 64;

  if (unboundedName.length <= maxLength) {
    return unboundedName;
  }

  const hash = createHash("sha256")
    .update(`${normalizedServerName}:${normalizedToolName}`)
    .digest("hex")
    .slice(0, 10);

  const fixedLength = "mcp__".length + "__".length + "__".length + hash.length;
  const availableLength = Math.max(8, maxLength - fixedLength);
  const serverBudget = Math.max(4, Math.floor(availableLength / 2));
  const toolBudget = Math.max(4, availableLength - serverBudget);

  const boundedServer = normalizedServerName.slice(0, serverBudget);
  const boundedTool = normalizedToolName.slice(0, toolBudget);
  return `mcp__${boundedServer}__${boundedTool}__${hash}`;
}
