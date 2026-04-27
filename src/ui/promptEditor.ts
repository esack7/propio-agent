import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface PromptEditorRunContext {
  command: string;
  filePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PromptEditorRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export type PromptEditorRunner = (
  context: PromptEditorRunContext,
) => PromptEditorRunResult;

export interface PromptEditorOptions {
  buffer: string;
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  editorCommand?: string | null;
  runEditor?: PromptEditorRunner;
}

export interface PromptEditorResult {
  status: "edited" | "missing" | "failed";
  buffer: string;
  message?: string;
}

const MISSING_EDITOR_MESSAGE = "Editor unavailable. Set VISUAL or EDITOR.";

function firstDefined(values: readonly (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function resolveEditorCommand(options: PromptEditorOptions): string | null {
  if (typeof options.editorCommand === "string") {
    return options.editorCommand.trim() || null;
  }

  const env = options.env ?? process.env;
  return firstDefined([env.VISUAL, env.EDITOR]);
}

function defaultRunEditor(
  context: PromptEditorRunContext,
): PromptEditorRunResult {
  return spawnSync(context.command, [context.filePath], {
    cwd: context.cwd,
    env: context.env,
    stdio: "inherit",
    shell: true,
  });
}

export function openPromptEditor(
  options: PromptEditorOptions,
): PromptEditorResult {
  const command = resolveEditorCommand(options);
  if (!command) {
    return {
      status: "missing",
      buffer: options.buffer,
      message: MISSING_EDITOR_MESSAGE,
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-editor-"));
  const filePath = path.join(tempDir, "prompt.txt");
  const env = options.env ?? process.env;
  const runEditor = options.runEditor ?? defaultRunEditor;

  try {
    fs.writeFileSync(filePath, options.buffer, "utf8");

    const result = runEditor({
      command,
      filePath,
      cwd: options.workspaceRoot,
      env,
    });

    if (result.error || result.status !== 0) {
      return {
        status: "failed",
        buffer: options.buffer,
        message:
          result.error?.message ??
          (result.status === null
            ? "Editor exited without a status."
            : `Editor exited with code ${result.status}.`),
      };
    }

    const edited = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    return {
      status: "edited",
      buffer: edited,
    };
  } catch (error) {
    return {
      status: "failed",
      buffer: options.buffer,
      message: error instanceof Error ? error.message : "Editor failed.",
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}
