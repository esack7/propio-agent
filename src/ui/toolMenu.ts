import { Agent } from "../agent.js";
import type { InteractiveInput } from "./interactiveInput.js";
import type { TerminalUi } from "./terminal.js";

/**
 * Show an interactive tool management menu.
 *
 * Displays all registered tools with their enabled/disabled status.
 * Users can toggle tools by entering their number, or exit with 'q' or empty input.
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
  const displayMenu = (): void => {
    const toolNames = agent.getToolNames();

    ui.info("\nTools:");
    toolNames.forEach((name, index) => {
      const status = agent.isToolEnabled(name) ? "[enabled]" : "[disabled]";
      ui.command(`  ${index + 1}. ${name.padEnd(20)} ${status}`);
    });
    ui.command("");
  };

  displayMenu();

  while (true) {
    const rawInput = await input.readLine(
      ui.prompt("Enter tool number to toggle, or 'q' to quit: "),
    );

    if (rawInput === null) {
      return;
    }

    const trimmed = rawInput.trim();

    if (trimmed === "" || trimmed.toLowerCase() === "q") {
      return;
    }

    const toolNumber = parseInt(trimmed, 10);
    const toolNames = agent.getToolNames();

    if (
      Number.isNaN(toolNumber) ||
      toolNumber < 1 ||
      toolNumber > toolNames.length
    ) {
      ui.error("Invalid input. Please enter a valid tool number.\n");
      displayMenu();
      continue;
    }

    const toolName = toolNames[toolNumber - 1];
    const isEnabled = agent.isToolEnabled(toolName);

    if (isEnabled) {
      agent.disableTool(toolName);
      ui.success(`\nDisabled tool: ${toolName}\n`);
    } else {
      agent.enableTool(toolName);
      ui.success(`\nEnabled tool: ${toolName}\n`);
    }

    displayMenu();
  }
}
