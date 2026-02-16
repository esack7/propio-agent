import { TerminalUi } from "../terminal.js";

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

describe("TerminalUi", () => {
  it("writes informational lines to stderr", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.info("hello");

    expect(stderr.chunks.join("")).toContain("hello");
    expect(stdout.chunks).toHaveLength(0);
  });

  it("writes JSON payloads only to stdout", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ui = new TerminalUi({
      interactive: false,
      json: true,
      plain: true,
      stdout,
      stderr,
    });

    ui.info("ignored");
    ui.writeJson({ response: "ok" });

    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toContain('"response": "ok"');
  });

  it("returns plain prompt text in plain mode", () => {
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: true,
    });

    expect(ui.prompt("You: ")).toBe("You: ");
  });

  it("ensures trailing newline on cleanup after token writes", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.writeAssistant("partial");
    ui.cleanup();

    expect(stderr.chunks.join("")).toBe("partial\n");
  });
});
