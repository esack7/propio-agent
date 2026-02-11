import * as fs from "fs";
import { ExecutableTool } from "./interface";
import { ChatTool } from "../providers/types";

/**
 * ReadFileTool reads the content of a file from the filesystem.
 * Migrated from agent.ts executeTool() switch case.
 */
export class ReadFileTool implements ExecutableTool {
  readonly name = "read_file";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "read_file",
        description: "Reads the content of a file from the filesystem",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "The path to the file to read",
            },
          },
          required: ["file_path"],
        },
      },
    };
  }

  execute(args: Record<string, any>): string {
    const filePath = args.file_path;
    const content = fs.readFileSync(filePath, "utf-8");
    return content;
  }
}

/**
 * WriteFileTool writes content to a file on the filesystem.
 * Migrated from agent.ts executeTool() switch case.
 */
export class WriteFileTool implements ExecutableTool {
  readonly name = "write_file";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "write_file",
        description: "Writes content to a file on the filesystem",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "The path to the file to write",
            },
            content: {
              type: "string",
              description: "The content to write to the file",
            },
          },
          required: ["file_path", "content"],
        },
      },
    };
  }

  execute(args: Record<string, any>): string {
    const filePath = args.file_path;
    const content = args.content;
    fs.writeFileSync(filePath, content, "utf-8");
    return `Successfully wrote to ${filePath}`;
  }
}
