import * as readline from "readline";
import { Agent } from "./agent.js";
import { getConfigPath } from "./providers/configLoader.js";
import {
  formatUserMessage,
  formatAssistantMessage,
  formatCommand,
  formatError,
  formatInfo,
  formatSubtle,
  formatSuccess,
} from "./ui/formatting.js";
import { OperationSpinner } from "./ui/spinner.js";

async function main() {
  // Load configuration from ~/.propio/providers.json
  const configPath = getConfigPath();

  const agent = new Agent({
    providersConfig: configPath,
    systemPrompt: `You are a helpful AI coding assistant with access to tools. Use the tools available to you to complete user requests effectively.

When you need to perform actions like reading files, searching code, or executing commands, use the appropriate tool by making a function call. You will receive the tool results and can use that information to continue helping the user.

Always provide clear, concise responses and summarize what you did after completing the user's request.`,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    formatInfo("AI Agent started. Type your message and press Enter."),
  );
  console.log(
    formatCommand(
      "Commands: /clear - clear context, /context - show context, /exit - quit\n",
    ),
  );

  // Show loaded tools for debugging
  const tools = agent.getTools();
  console.log(
    formatInfo(
      `Loaded ${tools.length} tools: ${tools.map((t) => t.function.name).join(", ")}\n`,
    ),
  );

  const prompt = () => {
    rl.question(formatUserMessage("You: "), async (input) => {
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        prompt();
        return;
      }

      if (trimmedInput === "/exit") {
        console.log(formatInfo("Saving session context..."));
        agent.saveContext("Exiting application");
        console.log(formatSuccess("Goodbye!"));
        rl.close();
        process.exit(0);
      }

      if (trimmedInput === "/clear") {
        agent.clearContext();
        console.log(formatSuccess("Session context cleared.\n"));
        prompt();
        return;
      }

      if (trimmedInput === "/context") {
        const context = agent.getContext();
        if (context.length === 0) {
          console.log(formatInfo("No session context.\n"));
        } else {
          console.log(formatInfo("Session Context:"));
          context.forEach((msg, index) => {
            console.log(
              formatSubtle(
                `${index + 1}. ${msg.role.toUpperCase()}: ${msg.content}`,
              ),
            );
          });
          console.log("");
        }
        prompt();
        return;
      }

      try {
        process.stdout.write(formatAssistantMessage("Assistant: "));

        let currentSpinner: OperationSpinner | null = null;

        await agent.streamChat(
          trimmedInput,
          (token) => {
            process.stdout.write(formatAssistantMessage(token));
          },
          {
            onToolStart: (toolName: string) => {
              // Stop spinner before starting a new one (in case of multiple tools)
              if (currentSpinner) {
                currentSpinner.stop();
              }
              currentSpinner = new OperationSpinner(`Executing ${toolName}...`);
              currentSpinner.start();
            },
            onToolEnd: (toolName: string, result: string) => {
              if (currentSpinner) {
                const preview = result.substring(0, 50);
                currentSpinner.succeed(
                  `${toolName} completed: ${preview}${result.length > 50 ? "..." : ""}`,
                );
                currentSpinner = null;
              }
            },
          },
        );
        console.log("\n");
      } catch (error) {
        console.error(
          formatError(
            `\nError: ${error instanceof Error ? error.message : "Unknown error"}\n`,
          ),
        );
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
