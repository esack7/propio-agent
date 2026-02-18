import { parseCliArgs, parseSandboxArgs } from "../args.js";

describe("cli args parsing", () => {
  it("parses sandbox flag and forwards all non-sandbox args", () => {
    const parsed = parseCliArgs([
      "--foo",
      "bar",
      "--sandbox",
      "--baz",
      "qux",
      "--sandbox",
    ]);

    expect(parsed.flags.sandbox).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--foo", "bar", "--baz", "qux"]);
  });

  it("keeps sandbox false when flag is absent", () => {
    const parsed = parseCliArgs(["--help", "--verbose"]);

    expect(parsed.flags.sandbox).toBe(false);
    expect(parsed.flags.help).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--help", "--verbose"]);
  });

  it("parses runtime behavior flags while preserving forwarded args", () => {
    const parsed = parseCliArgs([
      "--json",
      "--plain",
      "--no-interactive",
      "--debug-llm",
      "-h",
      "--foo",
    ]);

    expect(parsed.flags.sandbox).toBe(false);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.plain).toBe(true);
    expect(parsed.flags.noInteractive).toBe(true);
    expect(parsed.flags.debugLlm).toBe(true);
    expect(parsed.flags.help).toBe(true);
    expect(parsed.forwardedArgs).toEqual([
      "--json",
      "--plain",
      "--no-interactive",
      "--debug-llm",
      "-h",
      "--foo",
    ]);
  });

  it("parses debug log file flag with separate path argument", () => {
    const parsed = parseCliArgs([
      "--debug-llm-file",
      "/tmp/llm-debug.log",
      "--debug-llm",
    ]);

    expect(parsed.flags.debugLlm).toBe(true);
    expect(parsed.flags.debugLlmFile).toBe("/tmp/llm-debug.log");
    expect(parsed.forwardedArgs).toEqual([
      "--debug-llm-file",
      "/tmp/llm-debug.log",
      "--debug-llm",
    ]);
  });

  it("parses debug log file flag with equals syntax", () => {
    const parsed = parseCliArgs([
      "--debug-llm-file=/tmp/llm-debug.log",
      "--json",
    ]);

    expect(parsed.flags.debugLlmFile).toBe("/tmp/llm-debug.log");
    expect(parsed.flags.json).toBe(true);
    expect(parsed.forwardedArgs).toEqual([
      "--debug-llm-file=/tmp/llm-debug.log",
      "--json",
    ]);
  });

  it("retains compatibility helper output shape", () => {
    const parsed = parseSandboxArgs(["--sandbox", "--help"]);

    expect(parsed.sandboxRequested).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--help"]);
  });
});
