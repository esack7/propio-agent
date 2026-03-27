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

  it("does not duplicate success symbol when finishing an active spinner", () => {
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: false,
    });

    const succeed = jest.fn();
    (ui as any).spinner = { succeed };

    ui.success("list_dir completed");

    expect(succeed).toHaveBeenCalledTimes(1);
    expect(succeed.mock.calls[0][0]).not.toContain("✔");
  });

  it("does not duplicate error symbol when failing an active spinner", () => {
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: false,
    });

    const fail = jest.fn();
    (ui as any).spinner = { fail };

    ui.error("list_dir failed");

    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).not.toContain("✖");
  });

  it("wraps long lines at word boundaries instead of truncating", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    stderr.columns = 40;
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.command(
      "Commands: /clear - clear context, /context - show context, /tools - manage tools, /exit - quit",
    );

    const output = stderr.chunks.join("");
    expect(output).not.toContain("…");
    expect(output).toContain("Commands: /clear - clear context,");
    expect(output).toContain("/context - show context, /tools -");
    expect(output).toContain("manage tools, /exit - quit");
  });

  it("does not split single long words when wrapping", () => {
    const stdout = createMockStream();
    const stderr = createMockStream();
    stderr.columns = 15;
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.info("supercalifragilisticexpialidocious word");

    const output = stderr.chunks.join("");
    expect(output).toContain("supercalifragilisticexpialidocious");
    expect(output).toContain("word");
    expect(output).not.toContain("…");
  });

  it("wraps ANSI-colored lines by visible width", () => {
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
    });

    const line = "\x1b[31mred\x1b[0m \x1b[32mblue\x1b[0m \x1b[33mgreen\x1b[0m";
    const wrapped = (ui as any).wrapLineAtWordBoundaries(line, 12);
    const stripped = wrapped.map((value: string) =>
      value.replace(/\x1b\[[0-9;]*m/g, ""),
    );

    expect(stripped).toEqual(["red blue", "green"]);
  });
});
