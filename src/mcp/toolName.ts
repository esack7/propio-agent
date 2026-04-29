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
  return `mcp__${normalizeMcpNameSegment(serverName)}__${normalizeMcpNameSegment(toolName)}`;
}
