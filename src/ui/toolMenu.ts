import { Agent } from "../agent.js";
import type { InteractiveInput } from "./interactiveInput.js";
import type { TerminalUi } from "./terminal.js";
import type { ToolSummary } from "../tools/registry.js";

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
  input: InteractiveInput,
  agent: Agent,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "prompt" | "success">,
): Promise<void> {
  const getOrderedTools = (): ToolSummary[] => {
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
  };

  const displayMenu = (): void => {
    const toolSummaries = getOrderedTools();

    ui.info("\nTools:");
    toolSummaries.forEach((summary, index) => {
      const status = summary.enabled ? "[enabled]" : "[disabled]";
      ui.command(
        `  ${index + 1}. ${summary.name.padEnd(20)} ${status} - ${summary.description}`,
      );
    });
    ui.command("");
  };

  displayMenu();

  while (true) {
    const rawInput = await input.readLine(
      ui.prompt(
        "Enter tool number, 'all on', 'all off', 'defaults', or blank to quit: ",
      ),
    );

    if (rawInput === null) {
      return;
    }

    const trimmed = rawInput.trim();

    if (trimmed === "") {
      return;
    }

    const normalized = trimmed.toLowerCase();
    const toolSummaries = getOrderedTools();

    if (normalized === "all on") {
      agent.enableAllTools();
      ui.success("\nEnabled all tools.\n");
      displayMenu();
      continue;
    }

    if (normalized === "all off") {
      agent.disableAllTools();
      ui.success("\nDisabled all tools.\n");
      displayMenu();
      continue;
    }

    if (normalized === "defaults") {
      agent.resetToolsToManifestDefaults();
      ui.success("\nRestored manifest defaults.\n");
      displayMenu();
      continue;
    }

    const toolNumber = parseInt(trimmed, 10);

    if (
      Number.isNaN(toolNumber) ||
      toolNumber < 1 ||
      toolNumber > toolSummaries.length
    ) {
      ui.error("Invalid input. Please enter a valid tool number.\n");
      displayMenu();
      continue;
    }

    const tool = toolSummaries[toolNumber - 1];
    const isEnabled = tool.enabled;

    if (isEnabled) {
      agent.disableTool(tool.name);
      ui.success(`\nDisabled tool: ${tool.name}\n`);
    } else {
      agent.enableTool(tool.name);
      ui.success(`\nEnabled tool: ${tool.name}\n`);
    }

    displayMenu();
  }
}
