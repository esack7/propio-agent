import * as fs from "fs";
import * as fsPromises from "fs/promises";
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const content = args.content as string;
    fs.writeFileSync(filePath, content, "utf-8");
    return `Successfully wrote to ${filePath}`;
  }
}

/**
 * ListDirTool lists the contents of a directory.
 * Returns entries with type (file or directory) and name.
 */
export class ListDirTool implements ExecutableTool {
  readonly name = "list_dir";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "list_dir",
        description: "Lists the contents of a directory at a given path. Returns entries with type (file or directory) and name.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The directory path to list",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = args.path as string;
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

    if (entries.length === 0) {
      return "Directory is empty";
    }

    const formatted = entries.map(entry => {
      const type = entry.isDirectory() ? "directory" : "file";
      return `${type}: ${entry.name}`;
    });

    return formatted.join("\n");
  }
}

/**
 * MkdirTool creates a directory at the specified path.
 * Creates intermediate parent directories if they don't exist.
 */
export class MkdirTool implements ExecutableTool {
  readonly name = "mkdir";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "mkdir",
        description: "Creates a directory at the specified path. Creates intermediate parent directories if they don't exist.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The directory path to create",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = args.path as string;
    await fsPromises.mkdir(dirPath, { recursive: true });
    return `Successfully created directory: ${dirPath}`;
  }
}

/**
 * RemoveTool deletes a file or directory at the specified path.
 * Supports recursive deletion for non-empty directories.
 * Disabled by default - must be explicitly enabled.
 */
export class RemoveTool implements ExecutableTool {
  readonly name = "remove";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "remove",
        description: "Deletes a file or directory at the specified path. WARNING: Supports recursive deletion for non-empty directories. This tool is disabled by default and must be explicitly enabled.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The file or directory path to remove",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const targetPath = args.path as string;
    await fsPromises.rm(targetPath, { recursive: true, force: true });
    return `Successfully removed: ${targetPath}`;
  }
}

/**
 * MoveTool moves or renames a file or directory.
 * Uses fs.rename which works for both files and directories.
 */
export class MoveTool implements ExecutableTool {
  readonly name = "move";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "move",
        description: "Moves or renames a file or directory from a source path to a destination path",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "The source file or directory path",
            },
            dest: {
              type: "string",
              description: "The destination file or directory path",
            },
          },
          required: ["path", "dest"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const sourcePath = args.path as string;
    const destPath = args.dest as string;
    await fsPromises.rename(sourcePath, destPath);
    return `Successfully moved ${sourcePath} to ${destPath}`;
  }
}
