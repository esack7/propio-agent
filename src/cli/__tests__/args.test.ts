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
    expect(parsed.forwardedArgs).toEqual(["--help", "--verbose"]);
  });

  it("retains compatibility helper output shape", () => {
    const parsed = parseSandboxArgs(["--sandbox", "--help"]);

    expect(parsed.sandboxRequested).toBe(true);
    expect(parsed.forwardedArgs).toEqual(["--help"]);
  });
});
