import * as fs from "fs";
import { ExecutableTool } from "./interface";
import { ToolContext } from "./types";
import { ChatTool } from "../providers/types";

/**
 * SaveSessionContextTool saves the current session context to a file.
 * Migrated from agent.ts executeTool() switch case.
 *
 * Uses ToolContext for dependency injection to access agent state without
 * coupling to the Agent class. The context uses property getters to ensure
 * fresh values are read at execution time.
 */
export class SaveSessionContextTool implements ExecutableTool {
  readonly name = "save_session_context";
  private context: ToolContext;

  /**
   * @param context - ToolContext with property getters for live agent state
   */
  constructor(context: ToolContext) {
    this.context = context;
  }

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "save_session_context",
        description:
          "Saves the current session context to a file. Call this after completing tasks to persist the session state.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Optional reason for saving the session context",
            },
          },
        },
      },
    };
  }

  execute(args: Record<string, any>): string {
    let content = `=== Session Context ===\n`;
    content += `System Prompt: ${this.context.systemPrompt}\n`;
    content += `Saved at: ${new Date().toISOString()}\n`;
    if (args.reason) {
      content += `Reason: ${args.reason}\n`;
    }
    content += "\n";

    if (this.context.sessionContext.length === 0) {
      content += "No session context.\n";
    } else {
      this.context.sessionContext.forEach((msg, index) => {
        content += `[${index + 1}] ${msg.role.toUpperCase()}:\n${msg.content}\n\n`;
      });
    }

    fs.writeFileSync(this.context.sessionContextFilePath, content, "utf-8");
    return `Successfully saved session context to ${this.context.sessionContextFilePath}`;
  }
}
