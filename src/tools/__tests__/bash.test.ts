// For ESM modules, use unstable_mockModule instead of jest.mock
const mockExecFileAsync = jest.fn();

jest.unstable_mockModule("child_process", () => ({
  execFile: jest.fn(),
}));

jest.unstable_mockModule("util", () => ({
  promisify: jest.fn(() => mockExecFileAsync),
}));

// Now do the dynamic import after mocks are set up
let RunBashTool: any;

beforeAll(async () => {
  const module = await import("../bash.js");
  RunBashTool = module.RunBashTool;
});

describe("RunBashTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should execute command and return JSON output", async () => {
    const tool = new RunBashTool();

    // Mock successful execution
    mockExecFileAsync.mockResolvedValue({
      stdout: "hello world\n",
      stderr: "",
    });

    const result = await tool.execute({ command: "echo hello world" });

    const parsed = JSON.parse(result);
    expect(parsed.stdout).toBe("hello world\n");
    expect(parsed.stderr).toBe("");
    expect(parsed.exit_code).toBe(0);
  });

  it("should handle non-zero exit code", async () => {
    const tool = new RunBashTool();

    // Mock command with non-zero exit
    const error: any = new Error("Command failed");
    error.code = 1;
    error.stdout = "partial output";
    error.stderr = "error message";
    mockExecFileAsync.mockRejectedValue(error);

    const result = await tool.execute({ command: "false" });

    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(1);
    expect(parsed.stdout).toBe("partial output");
    expect(parsed.stderr).toBe("error message");
  });

  it("should handle timeout", async () => {
    const tool = new RunBashTool();

    // Mock timeout
    const error: any = new Error("Command timed out");
    error.killed = true;
    error.stdout = "";
    error.stderr = "";
    mockExecFileAsync.mockRejectedValue(error);

    const result = await tool.execute({
      command: "sleep 100",
      timeout: 1000,
    });

    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(-1);
    expect(parsed.stderr).toContain("timed out");
  });

  it("should use custom working directory", async () => {
    const tool = new RunBashTool();

    mockExecFileAsync.mockResolvedValue({
      stdout: "output",
      stderr: "",
    });

    await tool.execute({ command: "pwd", cwd: "/custom/dir" });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "pwd"],
      expect.objectContaining({
        cwd: "/custom/dir",
      }),
    );
  });

  it("should merge environment variables", async () => {
    const tool = new RunBashTool();

    mockExecFileAsync.mockResolvedValue({
      stdout: "output",
      stderr: "",
    });

    await tool.execute({
      command: "echo $CUSTOM_VAR",
      env: { CUSTOM_VAR: "custom_value" },
    });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "echo $CUSTOM_VAR"],
      expect.objectContaining({
        env: expect.objectContaining({
          CUSTOM_VAR: "custom_value",
        }),
      }),
    );
  });

  it("should truncate large output", async () => {
    const tool = new RunBashTool();
    const largeOutput = "x".repeat(60 * 1024); // 60KB (exceeds 50KB limit)

    mockExecFileAsync.mockResolvedValue({
      stdout: largeOutput,
      stderr: "",
    });

    const result = await tool.execute({ command: "generate_large_output" });

    const parsed = JSON.parse(result);
    expect(parsed.stdout.length).toBeLessThan(largeOutput.length);
    expect(parsed.stdout.length).toBe(50 * 1024); // Truncated to 50KB
  });

  it("should have correct schema with warning", () => {
    const tool = new RunBashTool();
    const schema = tool.getSchema();

    expect(schema.function.name).toBe("run_bash");
    expect(schema.function.description).toContain("WARNING");
    expect(schema.function.parameters.required).toContain("command");
  });

  it("should have name matching schema", () => {
    const tool = new RunBashTool();
    const schema = tool.getSchema();

    expect(tool.name).toBe(schema.function.name);
  });
});
