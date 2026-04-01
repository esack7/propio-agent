import * as readline from "readline";
import type { Agent } from "../agent.js";
import type { TerminalUi } from "./terminal.js";

/**
 * Show an interactive tool management menu.
 *
 * Displays all registered tools with their enabled/disabled status.
 * Users can toggle tools by entering their number, or exit with 'q' or empty input.
 * Dangerous tools require explicit confirmation before enabling.
 *
 * @param rl - readline.Interface for user interaction
 * @param agent - Agent instance to query and modify tool state
 * @param onDone - Callback to invoke when user exits the menu
 */
export function showToolMenu(
  rl: readline.Interface,
  agent: Agent,
  onDone: () => void,
  ui: Pick<TerminalUi, "command" | "error" | "info" | "prompt" | "success">,
): void {
  const displayMenu = () => {
    const toolNames = agent.getToolNames();

    ui.info("\nTools:");
    toolNames.forEach((name, index) => {
      const status = agent.isToolEnabled(name) ? "[enabled]" : "[disabled]";
      ui.command(`  ${index + 1}. ${name.padEnd(20)} ${status}`);
    });
    ui.command("");
  };

  const promptUser = () => {
    rl.question(
      ui.prompt("Enter tool number to toggle, or 'q' to quit: "),
      (input) => {
        const trimmed = input.trim();

        // Exit on 'q' or empty input
        if (trimmed === "" || trimmed.toLowerCase() === "q") {
          onDone();
          return;
        }

        // Parse number input
        const toolNumber = parseInt(trimmed, 10);
        const toolNames = agent.getToolNames();

        // Validate input
        if (
          isNaN(toolNumber) ||
          toolNumber < 1 ||
          toolNumber > toolNames.length
        ) {
          ui.error("Invalid input. Please enter a valid tool number.\n");
          displayMenu();
          promptUser();
          return;
        }

        const toolName = toolNames[toolNumber - 1];
        const isEnabled = agent.isToolEnabled(toolName);

        // Toggle logic
        if (isEnabled) {
          // Disable (no confirmation needed)
          agent.disableTool(toolName);
          ui.success(`\nDisabled tool: ${toolName}\n`);
          displayMenu();
          promptUser();
        } else {
          agent.enableTool(toolName);
          ui.success(`\nEnabled tool: ${toolName}\n`);
          displayMenu();
          promptUser();
        }
      },
    );
  };

  // Start the menu
  displayMenu();
  promptUser();
}
