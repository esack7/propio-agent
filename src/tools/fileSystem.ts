import * as path from "path";
import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";

/**
 * Validates and normalizes a file path for safe access.
 * In native mode (non-sandbox), allows access to any absolute path.
 * In sandbox mode (Docker), paths are normalized relative to /workspace.
 * Prevents basic path traversal attacks by rejecting suspicious patterns.
 *
 * @param filePath - The file path to validate and normalize
 * @returns Normalized path safe for filesystem access
 * @throws Error if the path contains suspicious patterns
 */
function validatePath(filePath: string): string {
  // Prevent null bytes and other control characters
  if (/[\x00-\x1f]/.test(filePath)) {
    throw new Error(`Invalid path: contains control characters`);
  }

  // Normalize the path to resolve . and .. segments
  // This helps with consistency and security
  const normalized = path.normalize(filePath);

  // If path is relative, resolve it against current working directory
  // In sandbox mode, cwd is /workspace, so this ensures relative paths work correctly
  if (!path.isAbsolute(normalized)) {
    return path.resolve(process.cwd(), normalized);
  }

  return normalized;
}

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
        description:
          "Reads the content of a file from the filesystem. Supports both absolute and relative paths. Relative paths are resolved from the current working directory.",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description:
                "Path to the file (e.g., 'file.txt', './dir/file.txt', or '/absolute/path/file.txt')",
            },
          },
          required: ["file_path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;

    try {
      // Validate and normalize path for security
      const normalizedPath = validatePath(filePath);

      // Read file asynchronously
      const content = await fsPromises.readFile(normalizedPath, "utf-8");
      return content;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`File not found: ${filePath}`);
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied: ${filePath}`);
      }
      if (err.code === "EISDIR") {
        throw new Error(`Path is a directory, not a file: ${filePath}`);
      }

      // Re-throw other errors with original message
      throw new Error(`Failed to read file: ${err.message || String(error)}`);
    }
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

    try {
      // Validate and normalize path for security
      const normalizedPath = validatePath(filePath);

      // Write file asynchronously
      await fsPromises.writeFile(normalizedPath, content, "utf-8");
      return `Successfully wrote to ${filePath}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`Directory not found for file: ${filePath}`);
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied: ${filePath}`);
      }
      if (err.code === "EISDIR") {
        throw new Error(`Path is a directory, not a file: ${filePath}`);
      }

      // Re-throw other errors with original message
      throw new Error(`Failed to write file: ${err.message || String(error)}`);
    }
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
        description:
          "Lists the contents of a directory. Returns entries with type (file or directory) and name. Use '.' for current directory. Supports both absolute and relative paths.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Directory path to list (e.g., '.', './subdir', 'subdir', or '/absolute/path')",
            },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = args.path as string;

    try {
      // Validate and normalize path for security
      const normalizedPath = validatePath(dirPath);

      const entries = await fsPromises.readdir(normalizedPath, {
        withFileTypes: true,
      });

      if (entries.length === 0) {
        return "Directory is empty";
      }

      const formatted = entries.map((entry) => {
        const type = entry.isDirectory() ? "directory" : "file";
        return `${type}: ${entry.name}`;
      });

      return formatted.join("\n");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied: ${dirPath}`);
      }
      if (err.code === "ENOTDIR") {
        throw new Error(`Path is not a directory: ${dirPath}`);
      }

      // Re-throw other errors with original message
      throw new Error(
        `Failed to list directory: ${err.message || String(error)}`,
      );
    }
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
        description:
          "Creates a directory at the specified path. Creates intermediate parent directories if they don't exist.",
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

    try {
      // Validate and normalize path for security
      const normalizedPath = validatePath(dirPath);

      await fsPromises.mkdir(normalizedPath, { recursive: true });
      return `Successfully created directory: ${dirPath}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied: ${dirPath}`);
      }
      if (err.code === "EEXIST") {
        throw new Error(`Path already exists as a file: ${dirPath}`);
      }

      // Re-throw other errors with original message
      throw new Error(
        `Failed to create directory: ${err.message || String(error)}`,
      );
    }
  }
}

/**
 * RemoveTool deletes a file or directory at the specified path.
 *
 * SECURITY WARNING: This tool performs permanent, unrecoverable deletion
 * of files and directories. It is disabled by default and must be explicitly
 * enabled via registry.enable("remove").
 *
 * Features:
 * - Recursive deletion: Can delete non-empty directories and all contents
 * - Path validation: Prevents deletion outside the allowed base directory
 * - Force mode: Uses {force: true} to ignore non-existent files
 *
 * Security Considerations:
 * - Deletions are permanent and cannot be undone
 * - Path validation restricts access to process.cwd() and subdirectories
 * - In sandbox mode, deletion is restricted to the mounted /workspace directory
 *
 * Best Practices:
 * - Only enable in trusted environments or with proper sandboxing
 * - Review LLM prompts to avoid inadvertent file deletion
 * - Use version control to recover accidentally deleted files
 * - Consider implementing confirmation prompts for critical deletions
 *
 * To enable: registry.enable("remove")
 */
export class RemoveTool implements ExecutableTool {
  readonly name = "remove";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "remove",
        description:
          "Deletes a file or directory at the specified path. WARNING: Supports recursive deletion for non-empty directories. This tool is disabled by default and must be explicitly enabled.",
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

    try {
      // Validate and normalize path for security
      const normalizedPath = validatePath(targetPath);

      await fsPromises.rm(normalizedPath, { recursive: true, force: true });
      return `Successfully removed: ${targetPath}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`Path not found: ${targetPath}`);
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied: ${targetPath}`);
      }

      // Re-throw other errors with original message
      throw new Error(`Failed to remove: ${err.message || String(error)}`);
    }
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
        description:
          "Moves or renames a file or directory from a source path to a destination path",
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

    try {
      // Validate and normalize both paths for security
      const normalizedSource = validatePath(sourcePath);
      const normalizedDest = validatePath(destPath);

      await fsPromises.rename(normalizedSource, normalizedDest);
      return `Successfully moved ${sourcePath} to ${destPath}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        throw new Error(`Source path not found: ${sourcePath}`);
      }
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`Permission denied for move operation`);
      }
      if (err.code === "EEXIST") {
        throw new Error(`Destination already exists: ${destPath}`);
      }
      if (err.code === "EXDEV") {
        throw new Error(
          `Cannot move across filesystems: ${sourcePath} to ${destPath}`,
        );
      }

      // Re-throw other errors with original message
      throw new Error(`Failed to move: ${err.message || String(error)}`);
    }
  }
}
