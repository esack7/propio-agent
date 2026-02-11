import { execFile } from "child_process";
import { RunBashTool } from "../bash";

// Mock child_process
jest.mock("child_process");
const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

describe("RunBashTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should execute command and return JSON output", async () => {
    const tool = new RunBashTool();

    // Mock successful execution
    mockExecFile.mockImplementation((file, args, options, callback: any) => {
      callback(null, { stdout: "hello world\n", stderr: "" });
      return {} as any;
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
    mockExecFile.mockImplementation((file, args, options, callback: any) => {
      const error: any = new Error("Command failed");
      error.code = 1;
      error.stdout = "partial output";
      error.stderr = "error message";
      callback(error, { stdout: "partial output", stderr: "error message" });
      return {} as any;
    });

    const result = await tool.execute({ command: "false" });

    const parsed = JSON.parse(result);
    expect(parsed.exit_code).toBe(1);
    expect(parsed.stdout).toBe("partial output");
    expect(parsed.stderr).toBe("error message");
  });

  it("should handle timeout", async () => {
    const tool = new RunBashTool();

    // Mock timeout
    mockExecFile.mockImplementation((file, args, options, callback: any) => {
      const error: any = new Error("Command timed out");
      error.killed = true;
      error.stdout = "";
      error.stderr = "";
      callback(error, { stdout: "", stderr: "" });
      return {} as any;
    });

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

    mockExecFile.mockImplementation((file, args, options: any, callback: any) => {
      expect(options.cwd).toBe("/custom/dir");
      callback(null, { stdout: "output", stderr: "" });
      return {} as any;
    });

    await tool.execute({ command: "pwd", cwd: "/custom/dir" });

    expect(mockExecFile).toHaveBeenCalled();
  });

  it("should merge environment variables", async () => {
    const tool = new RunBashTool();

    mockExecFile.mockImplementation((file, args, options: any, callback: any) => {
      expect(options.env.CUSTOM_VAR).toBe("custom_value");
      callback(null, { stdout: "output", stderr: "" });
      return {} as any;
    });

    await tool.execute({
      command: "echo $CUSTOM_VAR",
      env: { CUSTOM_VAR: "custom_value" },
    });

    expect(mockExecFile).toHaveBeenCalled();
  });

  it("should truncate large output", async () => {
    const tool = new RunBashTool();
    const largeOutput = "x".repeat(60 * 1024); // 60KB (exceeds 50KB limit)

    mockExecFile.mockImplementation((file, args, options, callback: any) => {
      callback(null, { stdout: largeOutput, stderr: "" });
      return {} as any;
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
