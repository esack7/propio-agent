import { TerminalUi } from "../terminal.js";
import { symbols } from "../symbols.js";
import { createTtyTestStream, stripAnsi } from "./ttyTestStream.js";

describe("TerminalUi", () => {
  it("writes informational lines to stderr", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
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
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
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

  it("returns the glyph chat prompt in plain interactive mode", () => {
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: true,
    });

    expect(ui.chatPrompt()).toBe(`${symbols.prompt} `);
  });

  it("returns the glyph chat prompt with styling in interactive mode", () => {
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: false,
    });

    expect(stripAnsi(ui.chatPrompt())).toBe(`${symbols.prompt} `);
  });

  it("begins interactive assistant turns with a blank line and gutter", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.beginAssistantResponse();

    const gutter = symbols.prompt === "❯" ? "│ " : "| ";
    expect(stderr.chunks.join("")).toBe(`\n${gutter}`);
  });

  it("preserves the Assistant prefix in non-interactive human-readable mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.beginAssistantResponse();

    expect(stderr.chunks.join("")).toBe("Assistant: ");
  });

  it("preserves the Assistant prefix in non-interactive rich mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: false,
      stdout,
      stderr,
    });

    ui.beginAssistantResponse();

    expect(stripAnsi(stderr.chunks.join(""))).toBe("Assistant: ");
  });

  it("suppresses assistant turn framing in JSON mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: true,
      json: true,
      plain: true,
      stdout,
      stderr,
    });

    ui.beginAssistantResponse();
    ui.writeAssistant("ignored");

    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toBe("");
  });

  it("ensures trailing newline on cleanup after token writes", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
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

  it("wraps long lines at word boundaries instead of truncating", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
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
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
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

  it("emits a newline before subtle output that follows a partial writeAssistant", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.beginAssistantResponse();
    ui.newline();
    ui.subtle("Prompt plan: mock/model iter=1 | ~500 prompt tokens (est.)");
    ui.writeAssistant("Here is ");
    ui.writeAssistant("the answer.");

    const output = stderr.chunks.join("");
    const lines = output.split("\n");

    expect(lines[0]).toBe("Assistant: ");
    expect(lines[1]).toContain("Prompt plan:");
    expect(lines[2]).toContain("Here is the answer.");
  });

  it("subtle output on its own line when no prior partial write exists", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.newline();
    ui.subtle("Prompt plan: standalone");

    const output = stderr.chunks.join("");
    expect(output).toBe("Prompt plan: standalone\n");
  });

  it("suppresses prompt plan output in JSON mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: true,
      plain: true,
      stdout,
      stderr,
    });

    ui.writeAssistant("ignored");
    ui.newline();
    ui.subtle("Prompt plan: should not appear");

    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toBe("");
  });

  it("renders idle footer and turn completion lines in subtle style", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: true,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.idleFooter("? help | /tools | /context | /session list | /exit");
    ui.turnComplete(4200);

    const output = stderr.chunks.join("");
    expect(output).toContain(
      "? help | /tools | /context | /session list | /exit",
    );
    expect(output).toContain("Turn complete in 4.2s");
  });

  it("suppresses idle footer and turn completion in JSON mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: true,
      json: true,
      plain: true,
      stdout,
      stderr,
    });

    ui.idleFooter("ignored");
    ui.turnComplete(1200);

    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toBe("");
  });

  it("suppresses idle footer and turn completion in non-interactive mode", () => {
    const stdout = createTtyTestStream();
    const stderr = createTtyTestStream();
    const ui = new TerminalUi({
      interactive: false,
      json: false,
      plain: true,
      stdout,
      stderr,
    });

    ui.idleFooter("ignored");
    ui.turnComplete(1200);

    expect(stderr.chunks.join("")).toBe("");
    expect(stdout.chunks.join("")).toBe("");
  });
});
