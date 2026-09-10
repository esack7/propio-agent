import { isAbsolute } from "node:path";
import { BashTool, type BashGlobalInstallGateConfig } from "./bash.js";
import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { EditTool } from "./edit.js";
import { GrepTool } from "./grep.js";
import { FindTool } from "./find.js";
import { LsTool } from "./ls.js";
import { resolveToolPath } from "./shared.js";
import type { ExecutableTool } from "./execution.js";
import type { PresentedTool } from "./interface.js";
import type { ShellExecutor } from "./nodeShell.js";

export interface LocalToolOptions {
  readonly workspaceRoot: string;
  readonly shellExecutor: ShellExecutor;
  /** Optional custom resolution/validation. Must return an absolute path. */
  readonly resolvePath?: (rawPath: unknown) => string;
  readonly outputInlineLimit?: number;
  readonly shell?: {
    readonly defaultTimeoutMs?: number;
    readonly maxTimeoutMs?: number;
    readonly globalInstallGate?: BashGlobalInstallGateConfig;
  };
}

export interface LocalToolDefinition {
  readonly tool: ExecutableTool;
  readonly enabledByDefault: boolean;
}

/** No configuration discovery, filesystem access, shell startup or skill wiring. */
export function createLocalTools(
  options: LocalToolOptions,
): ReadonlyArray<LocalToolDefinition> {
  return createLocalToolDefinitions(options).map(
    ({ tool, enabledByDefault }) => ({
      tool: executionOnly(tool),
      enabledByDefault,
    }),
  );
}

/** The runtime retains optional labels/adapters on the same implementations. */
export function createLocalToolDefinitions(
  options: LocalToolOptions,
): ReadonlyArray<{ tool: PresentedTool; enabledByDefault: boolean }> {
  if (!isAbsolute(options.workspaceRoot))
    throw new Error("workspaceRoot must be absolute");
  if (typeof options.shellExecutor !== "function")
    throw new Error("shellExecutor is required");
  const workspaceRoot = options.workspaceRoot;
  const customResolver = options.resolvePath;
  const resolvePath = (rawPath: unknown): string => {
    const resolved = customResolver
      ? customResolver(rawPath)
      : resolveToolPath(rawPath, workspaceRoot);
    if (!isAbsolute(resolved))
      throw new Error("resolvePath must return an absolute path");
    return resolved;
  };
  const pathOptions = {
    resolvePath,
    outputInlineLimit: options.outputInlineLimit,
  };
  return [
    { tool: new ReadTool(pathOptions), enabledByDefault: true },
    { tool: new WriteTool(pathOptions), enabledByDefault: true },
    { tool: new EditTool(pathOptions), enabledByDefault: true },
    {
      tool: new BashTool({
        ...pathOptions,
        ...options.shell,
        workspaceRoot,
        shellExecutor: options.shellExecutor,
      }),
      enabledByDefault: true,
    },
    { tool: new GrepTool(pathOptions), enabledByDefault: false },
    { tool: new FindTool(pathOptions), enabledByDefault: false },
    { tool: new LsTool(pathOptions), enabledByDefault: false },
  ];
}

function executionOnly(tool: PresentedTool): ExecutableTool {
  return {
    name: tool.name,
    description: tool.description,
    getSchema: () => tool.getSchema(),
    execute: (args, context) => tool.execute(args, context),
    ...(tool.executeWithStatus
      ? { executeWithStatus: tool.executeWithStatus.bind(tool) }
      : {}),
  };
}
