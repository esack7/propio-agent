/** What a tool can touch. Policy reasons about these, never about tool names. */
export const CAPABILITIES = [
  "read",
  "workspace_write",
  "process",
  "network",
  "external",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface ToolMetadata {
  readonly capabilities: readonly Capability[];
  /** The tool changes nothing outside its own output. */
  readonly readOnly: boolean;
  /** Independent calls may run at the same time. */
  readonly concurrencySafe: boolean;
}

/**
 * Applied to a tool that declares nothing, and to every MCP tool: its effects
 * are unknown, so it always needs a decision and never runs concurrently.
 */
export const UNDECLARED_TOOL_METADATA: ToolMetadata = Object.freeze({
  capabilities: Object.freeze(["external"] as const),
  readOnly: false,
  concurrencySafe: false,
});

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value)
  );
}

export function resolveToolMetadata(
  metadata: ToolMetadata | undefined,
): ToolMetadata {
  return metadata ?? UNDECLARED_TOOL_METADATA;
}
