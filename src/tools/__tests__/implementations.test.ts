import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.unstable_mockModule("fs/promises", () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  readdir: jest.fn(),
  mkdir: jest.fn(),
  rm: jest.fn(),
  rename: jest.fn(),
  stat: jest.fn(),
}));

jest.unstable_mockModule("fast-glob", () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule("child_process", () => ({
  execFile: jest.fn(),
}));

jest.unstable_mockModule("util", () => ({
  promisify: jest.fn(),
}));

let createDefaultToolRegistry: any;
let ReadTool: any;
let WriteTool: any;
let EditTool: any;
let BashTool: any;
let GrepTool: any;
let FindTool: any;
let LsTool: any;
let mockFsPromises: jest.Mocked<any>;
let mockFg: jest.MockedFunction<any>;
const mockExecFileAsync = jest.fn();

beforeAll(async () => {
  mockFsPromises = (await import("fs/promises")) as jest.Mocked<any>;
  mockFg = (await import("fast-glob")).default as jest.MockedFunction<any>;
  await import("child_process");
  const util = await import("util");
  jest.mocked(util.promisify).mockReturnValue(mockExecFileAsync as any);

  const factory = await import("../factory.js");
  createDefaultToolRegistry = factory.createDefaultToolRegistry;

  const readModule = await import("../read.js");
  ReadTool = readModule.ReadTool;

  const writeModule = await import("../write.js");
  WriteTool = writeModule.WriteTool;

  const editModule = await import("../edit.js");
  EditTool = editModule.EditTool;

  const bashModule = await import("../bash.js");
  BashTool = bashModule.BashTool;

  const grepModule = await import("../grep.js");
  GrepTool = grepModule.GrepTool;

  const findModule = await import("../find.js");
  FindTool = findModule.FindTool;

  const lsModule = await import("../ls.js");
  LsTool = lsModule.LsTool;
});

describe("Tool Implementations", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.clearAllMocks();
    process.cwd = jest.fn(() => "/test");
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  describe("ReadTool", () => {
    it("reads file contents", async () => {
      const tool = new ReadTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("file content"));

      const result = await tool.execute({ path: "/test/file.txt" });

      expect(result).toBe("file content");
    });

    it("rejects directories", async () => {
      const tool = new ReadTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);

      await expect(tool.execute({ path: "/test/dir" })).rejects.toThrow(
        "Path is a directory, not a file",
      );
    });

    it("rejects missing files", async () => {
      const tool = new ReadTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      jest.mocked(mockFsPromises.stat).mockRejectedValue(error);

      await expect(tool.execute({ path: "/test/missing.txt" })).rejects.toThrow(
        "File not found",
      );
    });

    it("rejects permission failures", async () => {
      const tool = new ReadTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      jest.mocked(mockFsPromises.stat).mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/protected.txt" }),
      ).rejects.toThrow("Permission denied");
    });

    it("truncates large files with an explicit marker", async () => {
      const tool = new ReadTool();
      const content = "x".repeat(60 * 1024);
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from(content));

      const result = await tool.execute({ path: "/test/large.txt" });

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("[output truncated]");
    });
  });

  describe("WriteTool", () => {
    it("writes content and creates parent directories", async () => {
      const tool = new WriteTool();
      jest.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined);
      jest.mocked(mockFsPromises.rename).mockResolvedValue(undefined);

      const result = await tool.execute({
        path: "/test/nested/file.txt",
        content: "new content",
      });

      expect(result).toBe("Wrote file: /test/nested/file.txt");
      expect(mockFsPromises.mkdir).toHaveBeenCalledWith("/test/nested", {
        recursive: true,
      });
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
      expect(mockFsPromises.rename).toHaveBeenCalledWith(
        expect.stringContaining("/test/nested/file.txt.tmp-"),
        "/test/nested/file.txt",
      );
    });

    it("propagates permission errors", async () => {
      const tool = new WriteTool();
      const error = new Error("EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      jest.mocked(mockFsPromises.writeFile).mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/protected.txt", content: "x" }),
      ).rejects.toThrow("Permission denied");
    });

    it("cleans up the temp file when atomic rename fails", async () => {
      const tool = new WriteTool();
      const error = new Error("rename failed");
      jest.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined);
      jest.mocked(mockFsPromises.rename).mockRejectedValue(error);
      jest.mocked(mockFsPromises.rm).mockResolvedValue(undefined);

      await expect(
        tool.execute({
          path: "/test/nested/file.txt",
          content: "new content",
        }),
      ).rejects.toThrow("Failed to write file");

      expect(mockFsPromises.rm).toHaveBeenCalled();
    });
  });

  describe("EditTool", () => {
    it("replaces a single exact match", async () => {
      const tool = new EditTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("hello world"));
      jest.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined);
      jest.mocked(mockFsPromises.rename).mockResolvedValue(undefined);

      const result = await tool.execute({
        path: "/test/file.txt",
        old_string: "world",
        new_string: "agent",
      });

      expect(result).toBe("Edited file: /test/file.txt (1 replacement)");
    });

    it("fails when the match is missing", async () => {
      const tool = new EditTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("hello world"));

      await expect(
        tool.execute({
          path: "/test/file.txt",
          old_string: "missing",
          new_string: "agent",
        }),
      ).rejects.toThrow("String not found in file");
    });

    it("fails when multiple matches are ambiguous", async () => {
      const tool = new EditTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("foo foo"));

      await expect(
        tool.execute({
          path: "/test/file.txt",
          old_string: "foo",
          new_string: "bar",
        }),
      ).rejects.toThrow("Multiple matches found for edit");
    });

    it("replaces all matches when replace_all is true", async () => {
      const tool = new EditTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("foo foo"));
      jest.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined);
      jest.mocked(mockFsPromises.rename).mockResolvedValue(undefined);

      const result = await tool.execute({
        path: "/test/file.txt",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      });

      expect(result).toBe("Edited file: /test/file.txt (2 replacements)");
    });
  });

  describe("BashTool", () => {
    it("returns structured JSON output for success", async () => {
      const tool = new BashTool();
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

    it("returns structured JSON output for non-zero exit", async () => {
      const tool = new BashTool();
      const error: any = new Error("failed");
      error.code = 1;
      error.stdout = "partial";
      error.stderr = "problem";
      mockExecFileAsync.mockRejectedValue(error);

      const result = await tool.execute({ command: "false" });
      const parsed = JSON.parse(result);

      expect(parsed.exit_code).toBe(1);
      expect(parsed.stdout).toBe("partial");
      expect(parsed.stderr).toBe("problem");
    });

    it("handles timeouts", async () => {
      const tool = new BashTool();
      const error: any = new Error("timed out");
      error.killed = true;
      mockExecFileAsync.mockRejectedValue(error);

      const result = await tool.execute({
        command: "sleep 10",
        timeout: 1,
      });
      const parsed = JSON.parse(result);

      expect(parsed.exit_code).toBe(-1);
      expect(parsed.stderr).toContain("timed out");
    });

    it("supports cwd and env overrides", async () => {
      const tool = new BashTool();
      mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      await tool.execute({
        command: "pwd",
        cwd: "/custom",
        env: { TEST_VAR: "value" },
      });

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        "/bin/sh",
        ["-c", "pwd"],
        expect.objectContaining({
          cwd: "/custom",
          env: expect.objectContaining({
            TEST_VAR: "value",
          }),
        }),
      );
    });

    it("truncates large output", async () => {
      const tool = new BashTool();
      mockExecFileAsync.mockResolvedValue({
        stdout: "x".repeat(60 * 1024),
        stderr: "",
      });

      const result = await tool.execute({ command: "generate" });
      const parsed = JSON.parse(result);

      expect(parsed.stdout).toContain("[output truncated]");
    });
  });

  describe("GrepTool", () => {
    it("finds literal matches in files", async () => {
      const tool = new GrepTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("line 1\nquery line\nline 3"));

      const result = await tool.execute({
        path: "/test/file.txt",
        pattern: "query",
      });

      expect(result).toContain("/test/file.txt:2:query line");
    });

    it("finds regex matches recursively", async () => {
      const tool = new GrepTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);
      mockFg.mockResolvedValue(["/test/dir/a.txt", "/test/dir/b.txt"]);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("match 123"));

      const result = await tool.execute({
        path: "/test/dir",
        pattern: "match\\s\\d+",
        regex: true,
      });

      expect(result).toContain("/test/dir/a.txt:1:match 123");
      expect(result).toContain("/test/dir/b.txt:1:match 123");
    });

    it("returns a no matches message", async () => {
      const tool = new GrepTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("nothing useful"));

      const result = await tool.execute({
        path: "/test/file.txt",
        pattern: "missing",
      });

      expect(result).toBe("No matches found for pattern: missing");
    });
  });

  describe("FindTool", () => {
    it("finds matching files under a directory", async () => {
      const tool = new FindTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);
      mockFg.mockResolvedValue(["/test/src/a.ts", "/test/src/b.ts"]);

      const result = await tool.execute({
        path: "/test/src",
        pattern: "*.ts",
      });

      expect(result).toBe("/test/src/a.ts\n/test/src/b.ts");
    });

    it("returns a no matches message", async () => {
      const tool = new FindTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);
      mockFg.mockResolvedValue([]);

      const result = await tool.execute({
        path: "/test/src",
        pattern: "*.md",
      });

      expect(result).toBe("No files found matching pattern: *.md");
    });
  });

  describe("LsTool", () => {
    it("lists directory contents with type information", async () => {
      const tool = new LsTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);
      jest.mocked(mockFsPromises.readdir).mockResolvedValue([
        {
          name: "b.txt",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: "a-dir",
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as any);

      const result = await tool.execute({ path: "/test" });

      expect(result).toContain("directory: a-dir/");
      expect(result).toContain("file: b.txt");
      expect(mockFsPromises.readdir).toHaveBeenCalledWith("/test", {
        withFileTypes: true,
      });
    });

    it("returns a helpful message for empty directories", async () => {
      const tool = new LsTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as any);
      jest.mocked(mockFsPromises.readdir).mockResolvedValue([]);

      const result = await tool.execute({ path: "/test/empty" });

      expect(result).toBe("Directory is empty");
    });

    it("rejects non-directory paths", async () => {
      const tool = new LsTool();
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);

      await expect(tool.execute({ path: "/test/file.txt" })).rejects.toThrow(
        "Path is not a directory",
      );
    });
  });

  describe("createDefaultToolRegistry", () => {
    it("registers exactly seven built-ins in the new order", () => {
      const registry = createDefaultToolRegistry();

      expect(registry.getToolNames()).toEqual([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
      ]);
    });

    it("enables exactly four built-ins by default", () => {
      const registry = createDefaultToolRegistry();

      expect(
        registry.getEnabledSchemas().map((tool: any) => tool.function.name),
      ).toEqual(["read", "write", "edit", "bash"]);
    });

    it("executes enabled built-ins", async () => {
      jest.mocked(mockFsPromises.stat).mockResolvedValue({
        isDirectory: () => false,
      } as any);
      jest
        .mocked(mockFsPromises.readFile)
        .mockResolvedValue(Buffer.from("hello"));

      const registry = createDefaultToolRegistry();
      const result = await registry.execute("read", { path: "/test/file.txt" });

      expect(result).toBe("hello");
    });
  });
});
