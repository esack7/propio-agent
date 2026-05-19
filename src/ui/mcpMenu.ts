import { getMcpConfigPath } from "../mcp/config.js";
import type {
  McpServerDetail,
  McpServerSummary,
  McpToolSummary,
} from "../mcp/types.js";
import type { Agent } from "../agent.js";
import type { TerminalUi } from "./terminal.js";

function formatSummary(summary: McpServerSummary): string {
  const state = `${summary.enabled ? "enabled" : "disabled"} / ${summary.status}`;
  const toolLabel = `${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`;
  return `${state} - ${toolLabel}`;
}

function formatActionFailure(
  action: string,
  summary: McpServerSummary,
): string {
  return summary.lastError
    ? `${action} ${summary.name} but it is still ${summary.status}: ${summary.lastError}`
    : `${action} ${summary.name} but it is still ${summary.status}.`;
}

function renderSummaries(
  ui: Pick<TerminalUi, "command" | "info" | "section">,
  summaries: ReadonlyArray<McpServerSummary>,
): void {
  if (summaries.length === 0) {
    ui.info(
      `No MCP servers configured. Edit ${getMcpConfigPath()} to add one.`,
    );
    return;
  }

  const labelWidth = Math.max(
    10,
    ...summaries.map((summary) => summary.name.length),
  );
  ui.section("MCP Servers");

  for (const summary of summaries) {
    ui.command(
      `  ${summary.name.padEnd(labelWidth)} - ${formatSummary(summary)}`,
    );
    if (summary.lastError) {
      ui.info(`    last error: ${summary.lastError}`);
    }
  }
}

function renderTools(
  ui: Pick<TerminalUi, "command" | "info" | "section">,
  tools: ReadonlyArray<McpToolSummary>,
  serverName?: string,
): void {
  if (tools.length === 0) {
    ui.info(
      serverName
        ? `No MCP tools discovered for ${serverName}.`
        : "No MCP tools discovered.",
    );
    return;
  }

  ui.section(serverName ? `MCP Tools: ${serverName}` : "MCP Tools");
  for (const tool of tools) {
    ui.command(`  ${tool.name} - ${tool.remoteToolName}`);
  }
}

function renderDetail(
  ui: Pick<TerminalUi, "command" | "info" | "section">,
  detail: McpServerDetail,
): void {
  ui.section(`MCP Server: ${detail.name}`);
  ui.info(
    `State: ${detail.enabled ? "enabled" : "disabled"} / ${detail.status}`,
  );
  ui.info(`Command: ${detail.command}`);
  ui.info(`Args: ${detail.args.length > 0 ? detail.args.join(" ") : "(none)"}`);
  ui.info(
    `Env keys: ${detail.envKeys.length > 0 ? detail.envKeys.join(", ") : "(none)"}`,
  );

  if (detail.instructions) {
    ui.info(`Instructions: ${detail.instructions}`);
  }

  if (detail.lastError) {
    ui.info(`Last error: ${detail.lastError}`);
  }

  renderTools(ui, detail.tools, detail.name);
}

function parseMcpCommand(input: string): {
  readonly subcommand: string;
  readonly rest: string;
} {
  const trimmed = input.trim();
  const remainder = trimmed.slice("/mcp".length).trimStart();

  if (remainder.length === 0) {
    return { subcommand: "", rest: "" };
  }

  const spaceIndex = remainder.indexOf(" ");
  if (spaceIndex < 0) {
    return { subcommand: remainder, rest: "" };
  }

  return {
    subcommand: remainder.slice(0, spaceIndex),
    rest: remainder.slice(spaceIndex + 1).trim(),
  };
}

type McpUi = Pick<
  TerminalUi,
  "command" | "error" | "info" | "section" | "success"
>;
type McpAgent = Pick<
  Agent,
  | "getMcpServerSummaries"
  | "getMcpServerDetail"
  | "listMcpTools"
  | "reconnectMcpServer"
  | "setMcpServerEnabled"
>;

function handleMcpGet(rest: string, agent: McpAgent, ui: McpUi): void {
  if (!rest) {
    ui.error("Usage: /mcp get <server>");
    return;
  }
  const detail = agent.getMcpServerDetail(rest);
  if (!detail) {
    ui.error(`Unknown MCP server: "${rest}"`);
    return;
  }
  renderDetail(ui, detail);
}

function handleMcpTools(rest: string, agent: McpAgent, ui: McpUi): void {
  try {
    renderTools(
      ui,
      rest ? agent.listMcpTools(rest) : agent.listMcpTools(),
      rest || undefined,
    );
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleMcpReconnect(
  rest: string,
  agent: McpAgent,
  ui: McpUi,
): Promise<void> {
  if (!rest) {
    ui.error("Usage: /mcp reconnect <server>");
    return;
  }
  try {
    const summary = await agent.reconnectMcpServer(rest);
    if (summary.status === "connected")
      ui.success(`Reconnected ${summary.name}: ${formatSummary(summary)}.`);
    else ui.error(formatActionFailure("Reconnected", summary));
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleMcpEnableDisable(
  subcommand: "enable" | "disable",
  rest: string,
  agent: McpAgent,
  ui: McpUi,
): Promise<void> {
  if (!rest) {
    ui.error(`Usage: /mcp ${subcommand} <server>`);
    return;
  }
  const enabling = subcommand === "enable";
  try {
    const summary = await agent.setMcpServerEnabled(rest, enabling);
    const label = enabling ? "Enabled" : "Disabled";
    if (!enabling || summary.status === "connected")
      ui.success(`${label} ${summary.name}: ${formatSummary(summary)}.`);
    else ui.error(formatActionFailure(label, summary));
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
  }
}

export async function handleMcpCommand(
  input: string,
  agent: McpAgent,
  ui: McpUi,
): Promise<void> {
  const { subcommand, rest } = parseMcpCommand(input);

  if (subcommand === "" || subcommand === "list") {
    renderSummaries(ui, agent.getMcpServerSummaries());
  } else if (subcommand === "get") {
    handleMcpGet(rest, agent, ui);
  } else if (subcommand === "tools") {
    handleMcpTools(rest, agent, ui);
  } else if (subcommand === "reconnect") {
    await handleMcpReconnect(rest, agent, ui);
  } else if (subcommand === "enable" || subcommand === "disable") {
    await handleMcpEnableDisable(subcommand, rest, agent, ui);
  } else {
    ui.error(
      `Unknown /mcp subcommand: "${subcommand}${rest ? ` ${rest}` : ""}"`,
    );
    ui.command(
      "Usage: /mcp [list | get <server> | tools [server] | reconnect <server> | enable <server> | disable <server>]",
    );
  }
  ui.command("");
}
