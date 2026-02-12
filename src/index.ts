import * as readline from "readline";
import * as path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Agent } from "./agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // Load configuration from .propio/providers.json
  const configPath = path.join(__dirname, "..", ".propio", "providers.json");

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

  console.log("AI Agent started. Type your message and press Enter.");
  console.log(
    "Commands: /clear - clear context, /context - show context, /exit - quit\n",
  );

  // Show loaded tools for debugging
  const tools = agent.getTools();
  console.log(
    `Loaded ${tools.length} tools: ${tools.map((t) => t.function.name).join(", ")}\n`,
  );

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmedInput = input.trim();

      if (!trimmedInput) {
        prompt();
        return;
      }

      if (trimmedInput === "/exit") {
        console.log("Saving session context...");
        agent.saveContext("Exiting application");
        console.log("Goodbye!");
        rl.close();
        process.exit(0);
      }

      if (trimmedInput === "/clear") {
        agent.clearContext();
        console.log("Session context cleared.\n");
        prompt();
        return;
      }

      if (trimmedInput === "/context") {
        const context = agent.getContext();
        if (context.length === 0) {
          console.log("No session context.\n");
        } else {
          console.log("Session Context:");
          context.forEach((msg, index) => {
            console.log(
              `${index + 1}. ${msg.role.toUpperCase()}: ${msg.content}`,
            );
          });
          console.log("");
        }
        prompt();
        return;
      }

      try {
        process.stdout.write("Assistant: ");
        await agent.streamChat(trimmedInput, (token) => {
          process.stdout.write(token);
        });
        console.log("\n");
      } catch (error) {
        console.error(
          `\nError: ${error instanceof Error ? error.message : "Unknown error"}\n`,
        );
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
