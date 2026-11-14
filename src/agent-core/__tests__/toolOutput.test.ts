import { afterEach, expect, it, jest } from "@jest/globals";
import { createToolOutput } from "../toolOutput.js";
import type { AgentVisibilityEvent } from "../events.js";
afterEach(() => jest.useRealTimers());
it("bounds noisy windows, preserves stream identity and accounts for UTF-8 drops", () => {
  jest.useFakeTimers();
  const events: AgentVisibilityEvent[] = [];
  const output = createToolOutput("a", (event) => events.push(event));
  for (let i = 0; i < 10000; i++)
    output.append({ stream: i % 2 ? "stdout" : "stderr", text: "界" });
  expect(events).toHaveLength(0);
  jest.advanceTimersByTime(100);
  expect(events.length).toBeLessThanOrEqual(32);
  const chunks = events.filter((e) => e.type === "tool_output");
  expect(
    chunks.reduce((n, e) => n + Buffer.byteLength(e.text), 0),
  ).toBeLessThanOrEqual(4096);
  expect(
    chunks.reduce((n, e) => n + Buffer.byteLength(e.text) + e.droppedBytes, 0),
  ).toBe(30000);
  expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  output.append({ stream: "stderr", text: "last" });
  output.close();
  const length = events.length;
  output.append({ stream: "stdout", text: "late" });
  jest.runAllTimers();
  expect(events).toHaveLength(length);
  expect(chunks.every((e) => e.transient && e.toolCallId === "a")).toBe(true);
});
it("isolates calls and observer exceptions", () => {
  jest.useFakeTimers();
  const events: unknown[] = [];
  const a = createToolOutput("a", () => {
    throw new Error("observer");
  });
  const b = createToolOutput("b", (event) => events.push(event));
  a.append({ stream: "stdout", text: "first" });
  b.append({ stream: "stderr", text: "second" });
  expect(() => jest.advanceTimersByTime(100)).not.toThrow();
  expect(events).toEqual([
    expect.objectContaining({ toolCallId: "b", text: "second" }),
  ]);
  a.close();
  b.close();
});

it("retains recent output in order and discards a cancelled window", () => {
  jest.useFakeTimers();
  const events: AgentVisibilityEvent[] = [];
  const output = createToolOutput("a", (e) => events.push(e));
  output.append({ stream: "stdout", text: "old".repeat(2000) });
  output.append({ stream: "stdout", text: "a\n" });
  output.append({ stream: "stderr", text: "E\n" });
  output.append({ stream: "stdout", text: "latest\n" });
  jest.advanceTimersByTime(100);
  const chunks = events.filter((e) => e.type === "tool_output");
  expect(chunks.map((e) => e.stream)).toEqual(["stdout", "stderr", "stdout"]);
  expect(chunks[chunks.length - 1].text).toBe("latest\n");
  expect(
    chunks.reduce((n, e) => n + Buffer.byteLength(e.text) + e.droppedBytes, 0),
  ).toBe(6011);
  output.append({ stream: "stdout", text: "cancelled" });
  output.close({ discard: true });
  expect(events).toHaveLength(3);
});
