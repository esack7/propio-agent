import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutableTool,
  createLocalTools,
  executeNodeShell,
  ToolRegistry,
} from "@propio-ai/agent/tools";

const workspaceRoot = await mkdtemp(join(tmpdir(), "propio-tools-example-"));
try {
  const registry = new ToolRegistry({
    approve: ({ name }) => name !== "bash",
  });
  for (const { tool, enabledByDefault } of createLocalTools({
    workspaceRoot,
    shellExecutor: executeNodeShell,
  })) {
    registry.register(tool, enabledByDefault);
  }
  await registry.execute("write", {
    path: "note.txt",
    content: "Hello from a headless consumer.",
  });
  console.log(await registry.execute("read", { path: "note.txt" }));

  // A real MCP consumer can use a public descriptor's name, description and
  // inputSchema, and delegate invoke to manager.executeToolWithStatus(name, args).
  registry.register(
    createExecutableTool({
      schema: {
        type: "function",
        function: {
          name: "remote_echo",
          description: "Caller-owned integration",
          parameters: { type: "object", properties: {} },
        },
      },
      invoke: async () => ({
        status: "success",
        content: "Remote integration uses the same registry.",
      }),
    }),
    true,
  );
  console.log(await registry.execute("remote_echo", {}));
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
