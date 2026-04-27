import {
  visibleLength,
  wrapTextToWidth,
  TerminalWriter,
} from "../terminalWriter.js";

function createMockStream(
  isTTY = true,
): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    chunks,
    columns: 80,
    isTTY,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

describe("TerminalWriter", () => {
  it("wraps ANSI-colored lines by visible width", () => {
    const line = "\x1b[31mred\x1b[0m \x1b[32mblue\x1b[0m \x1b[33mgreen\x1b[0m";
    const wrapped = wrapTextToWidth(line, 12);
    const stripped = wrapped.map((value: string) =>
      value.replace(/\x1b\[[0-9;]*m/g, ""),
    );

    expect(visibleLength(line)).toBe(14);
    expect(stripped).toEqual(["red blue", "green"]);
  });

  it("emits a newline when cleanup follows a partial stderr write", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const writer = new TerminalWriter({ stdout, stderr });

    writer.writeStderr("partial");
    writer.newline();

    expect(stderr.chunks.join("")).toBe("partial\n");
    expect(stdout.chunks).toHaveLength(0);
  });

  it("clears the current stderr line before moving upward", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const writer = new TerminalWriter({ stdout, stderr });

    writer.clearStderrLines(2);

    expect(stderr.chunks.join("")).toBe(
      "\u001b[1G\u001b[2K\u001b[1A\u001b[1G\u001b[2K",
    );
  });
});
