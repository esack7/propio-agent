import { Agent } from "../agent.js";
import type { PromptComposer } from "./promptComposer.js";
import type { TerminalUi } from "./terminal.js";
import type { ToolSummary } from "../tools/registry.js";

type ToolMenuUi = Pick<
  TerminalUi,
  "command" | "error" | "prompt" | "section" | "success"
>;

type ToolMenuCommand = "all on" | "all off" | "defaults";

function getOrderedTools(agent: Agent): ToolSummary[] {
  const registrationOrder = new Map(
    agent.getToolNames().map((name, index) => [name, index]),
  );

  return [...agent.getToolSummaries()].sort((a, b) => {
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return (
      (registrationOrder.get(a.name) ?? 0) -
      (registrationOrder.get(b.name) ?? 0)
    );
  });
}

function displayToolMenu(agent: Agent, ui: ToolMenuUi): void {
  const toolSummaries = getOrderedTools(agent);
  const labelWidth = Math.max(
    8,
    ...toolSummaries.map((summary) => summary.name.length),
  );

  ui.section("Tools");
  for (const [index, summary] of toolSummaries.entries()) {
    const status = summary.enabled ? "[enabled]" : "[disabled]";
    ui.command(
      `  ${index + 1}. ${summary.name.padEnd(labelWidth)} ${status} - ${summary.description}`,
    );
  }
}

async function readToolMenuInput(
  composer: PromptComposer,
  ui: ToolMenuUi,
): Promise<string | null> {
  const result = await composer.compose({
    mode: "menu",
    promptText: ui.prompt(
      "Enter tool number, 'all on', 'all off', 'defaults', or blank to quit: ",
    ),
  });

  if (result.status === "closed") {
    return null;
  }

  const trimmed = result.submission.displayText.trim();
  return trimmed === "" ? null : trimmed;
}

function parseBulkCommand(input: string): ToolMenuCommand | null {
  const normalized = input.toLowerCase();
  if (
    normalized === "all on" ||
    normalized === "all off" ||
    normalized === "defaults"
  ) {
    return normalized;
  }
  return null;
}

function applyBulkCommand(
  command: ToolMenuCommand,
  agent: Agent,
  ui: ToolMenuUi,
): void {
  switch (command) {
    case "all on":
      agent.enableAllTools();
      ui.success("\nEnabled all tools.\n");
      return;
    case "all off":
      agent.disableAllTools();
      ui.success("\nDisabled all tools.\n");
      return;
    case "defaults":
      agent.resetToolsToManifestDefaults();
      ui.success("\nRestored manifest defaults.\n");
      return;
  }
}

function toolNumberFromInput(input: string, toolCount: number): number | null {
  const toolNumber = Number.parseInt(input, 10);
  if (Number.isNaN(toolNumber) || toolNumber < 1 || toolNumber > toolCount) {
    return null;
  }
  return toolNumber;
}

function toggleTool(agent: Agent, ui: ToolMenuUi, tool: ToolSummary): void {
  if (tool.enabled) {
    agent.disableTool(tool.name);
    ui.success(`\nDisabled tool: ${tool.name}\n`);
  } else {
    agent.enableTool(tool.name);
    ui.success(`\nEnabled tool: ${tool.name}\n`);
  }
}

/**
 * Show an interactive tool management menu.
 *
 * Displays all registered tools with their enabled/disabled status.
 * Users can toggle tools by entering their number, or exit with empty input.
 *
 * @param input - Shared interactive input service
 * @param agent - Agent instance to query and modify tool state
 * @param ui - Terminal UI renderer
 */
export async function showToolMenu(
  composer: PromptComposer,
  agent: Agent,
  ui: ToolMenuUi,
): Promise<void> {
  displayToolMenu(agent, ui);

  while (true) {
    const input = await readToolMenuInput(composer, ui);
    if (input === null) {
      return;
    }

    const bulkCommand = parseBulkCommand(input);
    if (bulkCommand) {
      applyBulkCommand(bulkCommand, agent, ui);
      displayToolMenu(agent, ui);
      continue;
    }

    const toolSummaries = getOrderedTools(agent);
    const toolNumber = toolNumberFromInput(input, toolSummaries.length);
    if (toolNumber === null) {
      ui.error("Invalid input. Please enter a valid tool number.\n");
      displayToolMenu(agent, ui);
      continue;
    }

    toggleTool(agent, ui, toolSummaries[toolNumber - 1]);
    displayToolMenu(agent, ui);
  }
}
