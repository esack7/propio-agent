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

  it.each([
    [["--permissions", "bypass"], "bypass"],
    [["--permissions=read-only"], "read-only"],
    [["--permissions", "accept-edits", "--json"], "accept-edits"],
  ])("parses %j as a permission preset and forwards it", (args, preset) => {
    const parsed = parseCliArgs(args);

    expect(parsed.parseErrors).toEqual([]);
    expect(parsed.flags.permissions).toBe(preset);
    expect(parsed.forwardedArgs.slice(0, 2)).toEqual(["--permissions", preset]);
  });

  it("leaves the permission preset unset when the flag is absent", () => {
    expect(parseCliArgs(["--json"]).flags.permissions).toBeUndefined();
  });

  it.each([
    [["--permissions", "everything"]],
    [["--permissions=nope"]],
    [["--permissions"]],
    [["--permissions", "--json"]],
  ])("rejects %j, naming the presets", (args) => {
    const parsed = parseCliArgs(args);

    expect(parsed.flags.permissions).toBeUndefined();
    expect(parsed.parseErrors).toEqual([
      "--permissions requires one of: read-only, ask, accept-edits, bypass",
    ]);
  });

  it("still parses a flag that follows a missing preset name", () => {
    expect(parseCliArgs(["--permissions", "--json"]).flags.json).toBe(true);
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
      "--show-status",
      "--show-reasoning-summary",
      "--show-trace",
      "--debug-llm",
      "-h",
      "--foo",
    ]);

    expect(parsed.flags.sandbox).toBe(false);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.plain).toBe(true);
    expect(parsed.flags.noInteractive).toBe(true);
    expect(parsed.flags.showStatus).toBe(true);
    expect(parsed.flags.showReasoningSummary).toBe(true);
    expect(parsed.flags.showTrace).toBe(true);
    expect(parsed.flags.debugLlm).toBe(true);
    expect(parsed.flags.help).toBe(true);
    expect(parsed.forwardedArgs).toEqual([
      "--json",
      "--plain",
      "--no-interactive",
      "--show-status",
      "--show-reasoning-summary",
      "--show-trace",
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

  it("records a parse error when --debug-llm-file has no following path", () => {
    const parsed = parseCliArgs(["--debug-llm-file"]);

    expect(parsed.flags.debugLlmFile).toBeUndefined();
    expect(parsed.parseErrors).toContain(
      "--debug-llm-file requires a file path argument",
    );
  });

  it("records a parse error when --debug-llm-file is followed by another flag", () => {
    const parsed = parseCliArgs(["--debug-llm-file", "--json"]);

    expect(parsed.flags.debugLlmFile).toBeUndefined();
    expect(parsed.flags.json).toBe(true);
    expect(parsed.parseErrors).toContain(
      "--debug-llm-file requires a file path argument",
    );
  });

  it("retains compatibility helper output shape", () => {
    const parsed = parseSandboxArgs(["--sandbox", "--help"]);

    expect(parsed.sandboxRequested).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--help"]);
  });

  it("parses --show-context-stats flag", () => {
    const parsed = parseCliArgs(["--show-context-stats", "--foo"]);

    expect(parsed.flags.showContextStats).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--show-context-stats", "--foo"]);
  });

  it("parses --show-prompt-plan flag", () => {
    const parsed = parseCliArgs(["--show-prompt-plan", "--foo"]);

    expect(parsed.flags.showPromptPlan).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--show-prompt-plan", "--foo"]);
  });

  it("keeps context stats and prompt plan flags false by default", () => {
    const parsed = parseCliArgs(["--help", "--json"]);

    expect(parsed.flags.showContextStats).toBe(false);
    expect(parsed.flags.showPromptPlan).toBe(false);
    expect(parsed.forwardedArgs).toEqual(["--help", "--json"]);
  });

  it("parses --version flag and forwards it", () => {
    const parsed = parseCliArgs(["--version", "--foo"]);

    expect(parsed.flags.version).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--version", "--foo"]);
  });

  it("parses -v flag and forwards it", () => {
    const parsed = parseCliArgs(["-v", "--json"]);

    expect(parsed.flags.version).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["-v", "--json"]);
  });

  it("keeps version false by default", () => {
    const parsed = parseCliArgs(["--help", "--json"]);

    expect(parsed.flags.version).toBe(false);
    expect(parsed.forwardedArgs).toEqual(["--help", "--json"]);
  });

  it("parses both context inspection flags together", () => {
    const parsed = parseCliArgs([
      "--show-context-stats",
      "--show-prompt-plan",
      "--json",
    ]);

    expect(parsed.flags.showContextStats).toBe(true);
    expect(parsed.flags.showPromptPlan).toBe(true);
    expect(parsed.forwardedArgs).toEqual([
      "--show-context-stats",
      "--show-prompt-plan",
      "--json",
    ]);
  });
});
