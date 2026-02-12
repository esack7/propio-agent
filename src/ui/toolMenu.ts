import * as readline from "readline";
import { Agent } from "../agent.js";
import {
  formatCommand,
  formatInfo,
  formatError,
  formatSuccess,
} from "./formatting.js";

// Tools that require explicit confirmation before enabling
const DANGEROUS_TOOLS = new Set(["run_bash", "remove"]);

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
): void {
  const displayMenu = () => {
    const toolNames = agent.getToolNames();

    console.log(formatInfo("\nTools:"));
    toolNames.forEach((name, index) => {
      const status = agent.isToolEnabled(name) ? "[enabled]" : "[disabled]";
      console.log(
        formatCommand(`  ${index + 1}. ${name.padEnd(20)} ${status}`),
      );
    });
    console.log("");
  };

  const promptUser = () => {
    rl.question(
      formatCommand("Enter tool number to toggle, or 'q' to quit: "),
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
          console.log(
            formatError("Invalid input. Please enter a valid tool number.\n"),
          );
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
          console.log(formatSuccess(`\nDisabled tool: ${toolName}\n`));
          displayMenu();
          promptUser();
        } else {
          // Enable - check if dangerous
          if (DANGEROUS_TOOLS.has(toolName)) {
            // Show warning and require confirmation
            console.log(
              formatError(
                `\nWARNING: '${toolName}' is a potentially dangerous tool that can modify or delete files.`,
              ),
            );
            rl.question(
              formatCommand("Are you sure you want to enable it? (y/n): "),
              (confirmation) => {
                const confirmTrimmed = confirmation.trim().toLowerCase();
                if (confirmTrimmed === "y") {
                  agent.enableTool(toolName);
                  console.log(formatSuccess(`\nEnabled tool: ${toolName}\n`));
                } else {
                  console.log(
                    formatInfo(`\nTool '${toolName}' remains disabled.\n`),
                  );
                }
                displayMenu();
                promptUser();
              },
            );
          } else {
            // Non-dangerous tool - enable immediately
            agent.enableTool(toolName);
            console.log(formatSuccess(`\nEnabled tool: ${toolName}\n`));
            displayMenu();
            promptUser();
          }
        }
      },
    );
  };

  // Start the menu
  displayMenu();
  promptUser();
}
