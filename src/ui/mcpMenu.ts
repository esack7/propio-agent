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

export async function handleMcpCommand(
  input: string,
  agent: Pick<
    Agent,
    | "getMcpServerSummaries"
    | "getMcpServerDetail"
    | "listMcpTools"
    | "reconnectMcpServer"
    | "setMcpServerEnabled"
  >,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "section" | "success">,
): Promise<void> {
  const parts = input.trim().split(/\s+/);

  if (parts.length === 1 || parts[1] === "list") {
    renderSummaries(ui, agent.getMcpServerSummaries());
    ui.command("");
    return;
  }

  if (parts[1] === "get") {
    const serverName = parts[2];
    if (!serverName || parts.length > 3) {
      ui.error("Usage: /mcp get <server>");
      ui.command("");
      return;
    }

    const detail = agent.getMcpServerDetail(serverName);
    if (!detail) {
      ui.error(`Unknown MCP server: "${serverName}"`);
      ui.command("");
      return;
    }

    renderDetail(ui, detail);
    ui.command("");
    return;
  }

  if (parts[1] === "tools") {
    if (parts.length > 3) {
      ui.error("Usage: /mcp tools [server]");
      ui.command("");
      return;
    }

    try {
      renderTools(ui, agent.listMcpTools(parts[2]), parts[2]);
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
    }
    ui.command("");
    return;
  }

  if (parts[1] === "reconnect") {
    const serverName = parts[2];
    if (!serverName || parts.length > 3) {
      ui.error("Usage: /mcp reconnect <server>");
      ui.command("");
      return;
    }

    try {
      const summary = await agent.reconnectMcpServer(serverName);
      if (summary.status === "connected") {
        ui.success(`Reconnected ${summary.name}: ${formatSummary(summary)}.`);
      } else {
        ui.error(formatActionFailure("Reconnected", summary));
      }
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
    }
    ui.command("");
    return;
  }

  if (parts[1] === "enable" || parts[1] === "disable") {
    const serverName = parts[2];
    if (!serverName || parts.length > 3) {
      ui.error(`Usage: /mcp ${parts[1]} <server>`);
      ui.command("");
      return;
    }

    try {
      const summary = await agent.setMcpServerEnabled(
        serverName,
        parts[1] === "enable",
      );
      if (parts[1] === "disable" || summary.status === "connected") {
        ui.success(
          `${parts[1] === "enable" ? "Enabled" : "Disabled"} ${summary.name}: ${formatSummary(summary)}.`,
        );
      } else {
        ui.error(formatActionFailure("Enabled", summary));
      }
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
    }
    ui.command("");
    return;
  }

  ui.error(`Unknown /mcp subcommand: "${parts.slice(1).join(" ")}"`);
  ui.command(
    "Usage: /mcp [list | get <server> | tools [server] | reconnect <server> | enable <server> | disable <server>]",
  );
  ui.command("");
}
