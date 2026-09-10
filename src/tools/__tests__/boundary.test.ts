import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutableTool,
  createLocalTools,
  executeNodeShell,
  ToolRegistry,
  type ExecutableTool,
  type ShellExecutor,
  type ToolExecutionResult,
} from "../index.js";

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "propio-tools-boundary-"));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

function localRegistry(
  shellExecutor: ShellExecutor = executeNodeShell,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const { tool, enabledByDefault } of createLocalTools({
    workspaceRoot: workspace,
    shellExecutor,
  })) {
    registry.register(tool, enabledByDefault);
  }
  return registry;
}

function integrationTool(
  invoke: () => Promise<ToolExecutionResult>,
): ExecutableTool {
  return createExecutableTool({
    schema: {
      type: "function",
      function: {
        name: "mcp_demo_read",
        description: "Remote reader",
        parameters: { type: "object", properties: {} },
      },
    },
    invoke,
  });
}

describe("headless local tools", () => {
  it("uses the supplied workspace for all seven tools instead of ambient cwd", async () => {
    const cwd = jest
      .spyOn(process, "cwd")
      .mockReturnValue("/unrelated-workspace");
    const registry = localRegistry();
    expect(registry.getToolNames()).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    expect(
      registry.getEnabledSchemas().map((schema) => schema.function.name),
    ).toEqual(["read", "write", "edit", "bash"]);
    expect(
      await registry.execute("write", {
        path: "notes.txt",
        content: "first\nsecond",
      }),
    ).toBe("Wrote file: notes.txt");
    await registry.execute("edit", {
      path: "notes.txt",
      old_string: "first",
      new_string: "updated",
    });
    expect(await registry.execute("read", { path: "notes.txt" })).toBe(
      "updated\nsecond",
    );
    registry.enableAll();
    expect(
      await registry.execute("grep", { path: ".", pattern: "updated" }),
    ).toBe(`${join(workspace, "notes.txt")}:1:updated`);
    expect(
      await registry.execute("find", { path: ".", pattern: "*.txt" }),
    ).toBe(join(workspace, "notes.txt"));
    expect(await registry.execute("ls", { path: "." })).toBe("file: notes.txt");
    const shell = JSON.parse(
      await registry.execute("bash", { command: "pwd" }),
    );
    // macOS may expose /var through its physical /private/var path.
    expect(shell.stdout.trim().replace(/^\/private/, "")).toBe(
      workspace.replace(/^\/private/, ""),
    );
    expect(cwd).toHaveBeenCalled(); // fast-glob eagerly evaluates its unused cwd fallback.
  });

  it("requires explicit workspace and shell dependencies", () => {
    expect(() =>
      createLocalTools({ workspaceRoot: ".", shellExecutor: executeNodeShell }),
    ).toThrow("workspaceRoot must be absolute");
    expect(() =>
      createLocalTools({ workspaceRoot: workspace } as never),
    ).toThrow("shellExecutor is required");
  });

  it("lets the consumer resolve paths, and rejects relative resolver results", async () => {
    await writeFile(join(workspace, "mapped.txt"), "mapped");
    for (const [resolved, status] of [
      [join(workspace, "mapped.txt"), "success"],
      ["relative.txt", "error"],
    ]) {
      const registry = new ToolRegistry();
      const definitions = createLocalTools({
        workspaceRoot: workspace,
        shellExecutor: executeNodeShell,
        resolvePath: () => resolved,
      });
      registry.register(definitions[0].tool, true);
      expect(
        (await registry.executeWithStatus("read", { path: "virtual" })).status,
      ).toBe(status);
    }
  });

  it("keeps full large reads and lets callers persist a preview", async () => {
    const content = "line\n".repeat(20000);
    await writeFile(join(workspace, "large.txt"), content);
    const outputs = new Map<string, string>();
    const registry = new ToolRegistry({
      processOutput: ({ name, result }) => {
        outputs.set(name, result.content);
        return {
          content: "stored preview",
          externalStorage: {
            externalPath: "memory:read",
            externalSizeBytes: Buffer.byteLength(result.content),
          },
        };
      },
    });
    registry.register(
      createLocalTools({
        workspaceRoot: workspace,
        shellExecutor: executeNodeShell,
      })[0].tool,
      true,
    );
    const result = await registry.executeWithStatus("read", {
      path: "large.txt",
    });
    expect(outputs.get("read")).toBe(content);
    expect(result).toEqual({
      status: "success",
      content: "stored preview",
      externalStorage: {
        externalPath: "memory:read",
        externalSizeBytes: 100000,
      },
    });
    expect(await localRegistry().execute("read", { path: "large.txt" })).toBe(
      content,
    );
  });

  it("reports filesystem errors without requiring a renderer", async () => {
    const result = await localRegistry().executeWithStatus("read", {
      path: "missing.txt",
    });
    expect(result.status).toBe("error");
    expect(result.content).toContain("File not found");
  });
});

describe("execution policies and integrations", () => {
  it.each([false, new Error("approval unavailable")])(
    "fails closed for approval %s",
    async (approval) => {
      const invoke = jest.fn(async () => ({
        status: "success" as const,
        content: "ran",
      }));
      const registry = new ToolRegistry({
        approve: () => {
          if (approval instanceof Error) throw approval;
          return approval;
        },
      });
      registry.register(integrationTool(invoke), true);
      expect(
        (await registry.executeWithStatus("mcp_demo_read", {})).status,
      ).toBe(approval === false ? "tool_disabled" : "error");
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("checks cancellation after pending approval and does not execute", async () => {
    const controller = new AbortController();
    const invoke = jest.fn(async () => ({
      status: "success" as const,
      content: "ran",
    }));
    const registry = new ToolRegistry({
      approve: async () => {
        controller.abort();
        return true;
      },
    });
    registry.register(integrationTool(invoke), true);
    expect(
      await registry.executeWithStatus(
        "mcp_demo_read",
        {},
        { signal: controller.signal },
      ),
    ).toEqual({
      status: "error",
      content: "Tool execution cancelled: mcp_demo_read",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not execute a tool disabled during approval", async () => {
    const invoke = jest.fn(async () => ({
      status: "success" as const,
      content: "ran",
    }));
    const registry = new ToolRegistry({
      approve: () => {
        registry.disable("mcp_demo_read");
        return true;
      },
    });
    registry.register(integrationTool(invoke), true);
    expect((await registry.executeWithStatus("mcp_demo_read", {})).status).toBe(
      "tool_disabled",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("executes the reviewed arguments even if caller or approver mutates their copy", async () => {
    const args = { path: "approved" };
    const registry = new ToolRegistry({
      approve: ({ args: review }) => {
        args.path = "changed";
        (review as Record<string, unknown>).path = "also changed";
        return true;
      },
    });
    registry.register(
      createExecutableTool({
        schema: integrationTool(async () => ({
          status: "success",
          content: "",
        })).getSchema(),
        invoke: async (input) => ({
          status: "success",
          content: String(input.path),
        }),
      }),
      true,
    );
    expect(await registry.execute("mcp_demo_read", args)).toBe("approved");
  });

  it.each(["success", "error", "tool_disabled", "tool_not_found"] as const)(
    "preserves MCP-style %s results through the same registry",
    async (status) => {
      const registry = localRegistry();
      registry.register(
        integrationTool(async () => ({ status, content: "remote response" })),
        true,
      );
      expect(await registry.executeWithStatus("mcp_demo_read", {})).toEqual({
        status,
        content: "remote response",
      });
    },
  );

  it("rechecks availability immediately before dispatch after the policy await", async () => {
    const invoke = jest.fn(async () => ({
      status: "success" as const,
      content: "ran",
    }));
    const registry = new ToolRegistry();
    registry.register(integrationTool(invoke), true);
    const pending = registry.executeWithStatus("mcp_demo_read", {});
    registry.disable("mcp_demo_read");
    expect((await pending).status).toBe("tool_disabled");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("retains the completed result if output persistence fails", async () => {
    const registry = new ToolRegistry({
      processOutput: () => {
        throw new Error("storage full");
      },
    });
    registry.register(
      integrationTool(async () => ({
        status: "success",
        content: "already executed",
      })),
      true,
    );
    expect(await registry.executeWithStatus("mcp_demo_read", {})).toEqual({
      status: "success",
      content: "already executed",
      outputPersistenceError: "storage full",
    });
  });
});

describe("shell execution dependencies", () => {
  it("passes focused settings, resolved cwd and cancellation to the supplied executor", async () => {
    const shell = jest
      .fn<ShellExecutor>()
      .mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const registry = localRegistry(shell);
    const signal = new AbortController().signal;
    await registry.execute(
      "bash",
      { command: "test", cwd: "nested", env: { TEST: "yes" } },
      { signal },
    );
    expect(shell).toHaveBeenCalledWith({
      command: "test",
      cwd: join(workspace, "nested"),
      env: { TEST: "yes" },
      timeoutMs: 120000,
      maxBuffer: 102400,
      abortSignal: signal,
    });
  });

  it("does not spawn or write for a pre-cancelled invocation", async () => {
    const shell = jest.fn<ShellExecutor>();
    const registry = localRegistry(shell);
    const signal = AbortSignal.abort();
    for (const name of ["bash", "write"]) {
      expect(
        (
          await registry.executeWithStatus(
            name,
            { command: "unused", path: "no.txt", content: "no" },
            { signal },
          )
        ).status,
      ).toBe("error");
    }
    expect(shell).not.toHaveBeenCalled();
    await expect(readFile(join(workspace, "no.txt"))).rejects.toThrow();
    const result = await executeNodeShell({
      command: "touch no.txt",
      cwd: workspace,
      abortSignal: signal,
    });
    expect(result.aborted).toBe(true);
    await expect(readFile(join(workspace, "no.txt"))).rejects.toThrow();
  });

  it("enforces the existing global-install gate before invoking the shell", async () => {
    const shell = jest
      .fn<ShellExecutor>()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const registry = localRegistry(shell);
    expect(
      (
        await registry.executeWithStatus("bash", {
          command: "npm install -g example",
        })
      ).status,
    ).toBe("error");
    expect(shell).not.toHaveBeenCalled();
    const approved = createLocalTools({
      workspaceRoot: workspace,
      shellExecutor: shell,
      shell: {
        globalInstallGate: {
          allowGlobalInstallsWithoutPrompt: false,
          requestGlobalInstallApproval: async () => true,
        },
      },
    });
    registry.register(approved[3].tool, true);
    expect(
      (
        await registry.executeWithStatus("bash", {
          command: "npm install -g example",
        })
      ).status,
    ).toBe("success");
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("reports nonzero exit codes and bounded output using the Node adapter", async () => {
    expect(
      await executeNodeShell({
        command: "printf failure >&2; exit 7",
        cwd: workspace,
      }),
    ).toEqual({ stdout: "", stderr: "failure", exitCode: 7 });
    const result = await executeNodeShell({
      command: "printf '%010000d' 1",
      cwd: workspace,
      maxBuffer: 64,
    });
    expect(result.maxBufferExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stderr).toContain("maxBuffer");
  });

  it("cancels a running local shell and retains its structured result", async () => {
    const controller = new AbortController();
    const pending = localRegistry().executeWithStatus(
      "bash",
      { command: "exec sleep 10" },
      { signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await pending;
      expect(result.status).toBe("error");
      expect(JSON.parse(result.content)).toMatchObject({
        exit_code: -1,
        stderr: "Command cancelled",
      });
    } finally {
      clearTimeout(timer);
    }
  });
});

it("preserves tool storage metadata when output processing only changes content", async () => {
  const externalStorage = {
    externalPath: "memory:original",
    externalSizeBytes: 5,
  };
  const registry = new ToolRegistry({
    processOutput: () => ({ content: "preview" }),
  });
  registry.register(
    integrationTool(async () => ({
      status: "success",
      content: "hello",
      externalStorage,
    })),
    true,
  );
  expect(await registry.executeWithStatus("mcp_demo_read", {})).toEqual({
    status: "success",
    content: "preview",
    externalStorage,
  });
});

it("allows output processing to preserve failure details based on status", async () => {
  const registry = new ToolRegistry({
    processOutput: ({ result }) => ({
      content: result.status === "success" ? "preview" : result.content,
    }),
  });
  registry.register(
    integrationTool(async () => ({
      status: "error",
      content: "failure detail",
    })),
    true,
  );
  expect(await registry.executeWithStatus("mcp_demo_read", {})).toMatchObject({
    status: "error",
    content: "failure detail",
  });
});

it("fails closed with a clear message for non-cloneable approval arguments", async () => {
  const invoke = jest.fn(async () => ({
    status: "success" as const,
    content: "ran",
  }));
  const registry = new ToolRegistry({ approve: () => true });
  registry.register(integrationTool(invoke), true);
  const result = await registry.executeWithStatus("mcp_demo_read", {
    callback: () => 1,
  });
  expect(result.status).toBe("error");
  expect(result.content).toContain(
    "arguments must be structured-cloneable when approval is configured",
  );
  expect(invoke).not.toHaveBeenCalled();
});
