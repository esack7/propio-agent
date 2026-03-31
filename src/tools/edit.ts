import * as fsPromises from "fs/promises";
import { ExecutableTool } from "./interface.js";
import { ChatTool } from "../providers/types.js";
import {
  normalizeToolPath,
  readUtf8TextFile,
  toStringArg,
  writeFileAtomically,
} from "./shared.js";

export class EditTool implements ExecutableTool {
  readonly name = "edit";

  getSchema(): ChatTool {
    return {
      type: "function",
      function: {
        name: "edit",
        description:
          "Edits an existing text file by replacing exact string matches. Fails when the match is missing or ambiguous unless replace_all is true.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to edit",
            },
            old_string: {
              type: "string",
              description: "Exact string to replace",
            },
            new_string: {
              type: "string",
              description: "Replacement string",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace every occurrence instead of requiring a single match",
              default: false,
            },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = args.path;
    const oldString = toStringArg(args.old_string, "old_string");
    const newString = toStringArg(args.new_string, "new_string");
    const replaceAll = args.replace_all === true;
    const path = normalizeToolPath(rawPath);

    try {
      const stats = await fsPromises.stat(path);
      if (stats.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      }

      if (oldString.length === 0) {
        throw new Error("old_string must be a non-empty string");
      }

      const original = await readUtf8TextFile(path);
      const occurrences = original.split(oldString).length - 1;

      if (occurrences === 0) {
        throw new Error(`String not found in file: ${oldString}`);
      }

      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `Multiple matches found for edit; set replace_all to true: ${oldString}`,
        );
      }

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString);

      await writeFileAtomically(path, updated);

      return replaceAll
        ? `Edited file: ${rawPath} (${occurrences} replacements)`
        : `Edited file: ${rawPath} (1 replacement)`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException | Error;

      if (err instanceof Error && err.message.startsWith("String not found")) {
        throw err;
      }
      if (
        err instanceof Error &&
        err.message === "old_string must be a non-empty string"
      ) {
        throw err;
      }
      if (
        err instanceof Error &&
        err.message.startsWith("Multiple matches found for edit")
      ) {
        throw err;
      }
      if (err instanceof Error && err.message.startsWith("Path is")) {
        throw err;
      }
      if ("code" in err && err.code === "ENOENT") {
        throw new Error(`File not found: ${rawPath}`);
      }
      if ("code" in err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new Error(`Permission denied: ${rawPath}`);
      }
      if ("code" in err && err.code === "EISDIR") {
        throw new Error(`Path is a directory, not a file: ${rawPath}`);
      }

      throw new Error(`Failed to edit file: ${err.message || String(error)}`);
    }
  }
}
