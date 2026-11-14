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

it("keeps partial lines per stream and handles progress and split CRLF", () => {
  let lines = appendLiveOutput([], "stdout", "abc");
  lines = appendLiveOutput(lines, "stderr", "x\n");
  lines = appendLiveOutput(lines, "stdout", "def\n");
  expect(lines.map((l) => l.text)).toEqual(["abcdef", "x"]);
  lines = appendLiveOutput(lines, "stdout", "10%\r");
  lines = appendLiveOutput(lines, "stdout", "11%\r12%\r");
  expect(lines[lines.length - 1].text).toBe("12%");
  lines = appendLiveOutput(lines, "stdout", "\nnext\r\n");
  expect(lines.slice(-2).map((l) => l.text)).toEqual(["12%", "next"]);
  expect(lines.every((l) => !l.text.includes("\r"))).toBe(true);
});

it.each(["def", "10%\rdef"])(
  "does not join a retained tail onto a skipped partial line (%s)",
  (head) => {
    let lines = appendLiveOutput([], "stdout", "abc");
    lines = appendLiveOutput(lines, "stdout", `${head}\n1\n2\n3\n4\n5\n6\n`);
    expect(lines.map((line) => line.text)).toEqual(["2", "3", "4", "5", "6"]);
  },
);
