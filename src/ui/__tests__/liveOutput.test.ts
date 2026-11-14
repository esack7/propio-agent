import { expect, it } from "@jest/globals";
import { appendLiveOutput } from "../liveOutput.js";
it("joins partial lines, bounds history, and preserves stream tags", () => {
  let lines = appendLiveOutput([], "stdout", "par");
  lines = appendLiveOutput(lines, "stdout", "tial\nnext\n");
  expect(lines.map((l) => l.text)).toEqual(["partial", "next"]);
  lines = appendLiveOutput(lines, "stderr", "warning\n");
  lines = appendLiveOutput(lines, "stdout", "a\nb\nc\n");
  expect(lines.map((l) => l.text)).toEqual(["next", "warning", "a", "b", "c"]);
  expect(lines[1].stream).toBe("stderr");
});
it("bounds a line and never starts with a sliced low surrogate", () => {
  const lines = appendLiveOutput([], "stdout", "😀" + "x".repeat(4095));
  expect(lines[0].text).toHaveLength(4095);
});
