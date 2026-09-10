import { jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";
import { closeClientBestEffort } from "../cleanup.js";

it("does not signal an exited child whose helper still owns the stdio pipes", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    process.stdin.resume();
    process.stdin.on("end", () => {
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { stdio: ["ignore", 1, 2] }).unref();
      process.exit(0);
    });
    process.stderr.write("ready");
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", script],
    stderr: "pipe",
  });
  const ready = new Promise<void>((resolve) =>
    transport.stderr!.once("data", () => resolve()),
  );
  const client = new Client({ name: "cleanup-test", version: "1" });
  const connecting = client.connect(transport).catch(() => {});
  await ready;
  // Verify the pinned SDK compatibility shim against a real spawned child.
  const child = (transport as unknown as { _process: ChildProcess })._process;
  const killed = jest.spyOn(child, "kill");
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    await closeClientBestEffort(client, transport, 200);
    await exited;
    expect(child.exitCode).toBe(0);
    expect(killed).not.toHaveBeenCalled();
  } finally {
    killed.mockRestore();
    await closed;
    await connecting;
  }
});
