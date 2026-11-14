import { expect, it } from "@jest/globals";
import {
  createTestAgent,
  ToolCallMockProvider,
  userSubmission,
} from "./testHelpers.js";
import type { AgentVisibilityEvent } from "../agent.js";

it("streams a real command before completion and retains final stdout, stderr and exit status", async () => {
  const events: AgentVisibilityEvent[] = [];
  let sawLive!: () => void;
  const live = new Promise<void>((resolve) => {
    sawLive = resolve;
  });
  const agent = createTestAgent(
    new ToolCallMockProvider("bash", {
      command:
        "printf first; sleep 0.4; printf last; printf warning >&2; exit 2",
    }),
  );
  let completed = false;
  const run = agent
    .streamChat(userSubmission("Go"), () => {}, {
      onEvent: (event) => {
        events.push(event);
        if (event.type === "tool_output") sawLive();
      },
    })
    .then(() => {
      completed = true;
    });
  await live;
  expect(completed).toBe(false);
  await run;
  const output = events.filter((e) => e.type === "tool_output");
  expect(output.map((e) => e.text).join("")).toContain("first");
  const finish = events.find((e) => e.type === "tool_finished");
  expect(finish).toMatchObject({
    display: {
      body: {
        kind: "command",
        stdoutTail: "firstlast",
        stderrTail: "warning",
        exitCode: 2,
      },
    },
    durationMs: expect.any(Number),
  });
  expect(events.findIndex((e) => e.type === "tool_output")).toBeLessThan(
    events.findIndex((e) => e.type === "tool_finished"),
  );
});

it("cancels live output without late events", async () => {
  const events: AgentVisibilityEvent[] = [];
  const controller = new AbortController();
  const agent = createTestAgent(
    new ToolCallMockProvider("bash", { command: "printf started; sleep 10" }),
  );
  await expect(
    agent.streamChat(userSubmission("Go"), () => {}, {
      abortSignal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "tool_output") controller.abort("escape");
      },
    }),
  ).rejects.toThrow();
  const length = events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(events).toHaveLength(length);
  expect(events.some((e) => e.type === "tool_output")).toBe(true);
});
