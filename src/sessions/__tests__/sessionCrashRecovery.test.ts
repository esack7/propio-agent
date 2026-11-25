import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import type { ChatRequest } from "@propio-ai/providers";
import { createTestAgent } from "../../__tests__/testHelpers.js";

it.each(["completed", "pending"])(
  "recovers after SIGKILL at the %s boundary without repeating calls",
  async (boundary) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "checkpoint-kill-"),
    );
    const child = fork(
      new URL("./fixtures/checkpointChild.mjs", import.meta.url),
      [directory, boundary],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let diagnostics = "";
    child.stderr!.on("data", (data) => {
      diagnostics += String(data);
    });
    const requests: ChatRequest[] = [];
    const agent = createTestAgent(
      {
        name: "fixture",
        getCapabilities: () => ({ contextWindowTokens: 32000 }),
        async *streamChat(request) {
          requests.push(request);
          yield { delta: "continued" };
        },
      },
      { sessionsDir: directory, mcpConfig: { mcpServers: {} } },
    );
    try {
      const message = await Promise.race([
        once(child, "message").then(([value]) => value),
        once(child, "exit").then(() => {
          throw new Error(diagnostics);
        }),
      ]);
      expect(message).toBe(boundary);
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      const count = fs.readFileSync(
        path.join(directory, "invocations"),
        "utf8",
      );
      expect(count.trim().split("\n")).toEqual(
        boundary === "pending" ? ["completed", "pending"] : ["completed"],
      );
      await agent.initialize();
      const original = fs.readFileSync(
        path.join(directory, "original.json"),
        "utf8",
      );
      await agent.importSessionWithWriter(original);
      const recovered = agent.exportSession();
      agent.importSession(recovered);
      agent.importSession(agent.exportSession());
      expect(agent.takeRecoveredGuidance()).toEqual([
        "first queued",
        "second queued",
      ]);
      expect(agent.takeRecoveredGuidance()).toEqual([]);
      expect(requests).toHaveLength(0);
      await agent.streamChat({ text: "continue" }, () => {});
      const messages = requests[0]!.messages;
      expect(
        messages.filter((message) =>
          message.content?.includes("original user task"),
        ),
      ).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            message.role === "tool" && message.toolCallId === "completed",
        ),
      ).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("durable completed result"),
        }),
      ]);
      expect(
        messages.filter(
          (message) =>
            message.role === "tool" && message.toolCallId === "pending",
        ),
      ).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("Completion is unknown"),
        }),
      ]);
      expect(fs.readFileSync(path.join(directory, "invocations"), "utf8")).toBe(
        count,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await agent.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  20000,
);
