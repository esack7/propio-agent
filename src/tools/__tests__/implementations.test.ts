// Import jest globals first
import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "@jest/globals";

// Mock fs/promises BEFORE any imports
jest.unstable_mockModule("fs/promises", () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  readdir: jest.fn(),
  mkdir: jest.fn(),
  rm: jest.fn(),
  rename: jest.fn(),
}));

// All imports must be dynamic to ensure mocks are in place
let createDefaultToolRegistry: any;
let ReadFileTool: any;
let WriteFileTool: any;
let mockFsPromises: any;

beforeAll(async () => {
  mockFsPromises = await import("fs/promises");

  const { createDefaultToolRegistry: factory } = await import("../factory.js");
  createDefaultToolRegistry = factory;

  const fileSystemModule = await import("../fileSystem.js");
  ReadFileTool = fileSystemModule.ReadFileTool;
  WriteFileTool = fileSystemModule.WriteFileTool;
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

  describe("ReadFileTool", () => {
    it("should read file and return content", async () => {
      const tool = new ReadFileTool();
      const mockContent = "file content here";
      jest.mocked(mockFsPromises.readFile).mockResolvedValue(mockContent);

      const result = await tool.execute({
        file_path: "/test/path/to/file.txt",
      });

      expect(result).toBe(mockContent);
      expect(mockFsPromises.readFile).toHaveBeenCalledWith(
        "/test/path/to/file.txt",
        "utf-8",
      );
    });

    it("should reject paths with control characters", async () => {
      const tool = new ReadFileTool();

      await expect(
        tool.execute({ file_path: "/test/file\x00.txt" }),
      ).rejects.toThrow("Invalid path: contains control characters");
    });

    it("should throw user-friendly error for non-existent file", async () => {
      const tool = new ReadFileTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      jest.mocked(mockFsPromises.readFile).mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/missing.txt" }),
      ).rejects.toThrow("File not found");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new ReadFileTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      jest.mocked(mockFsPromises.readFile).mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/protected.txt" }),
      ).rejects.toThrow("Permission denied");
    });

    it("should throw user-friendly error when path is a directory", async () => {
      const tool = new ReadFileTool();
      const error = new Error("EISDIR") as NodeJS.ErrnoException;
      error.code = "EISDIR";
      jest.mocked(mockFsPromises.readFile).mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/dir" }),
      ).rejects.toThrow("Path is a directory, not a file");
    });

    it("should have correct schema", () => {
      const tool = new ReadFileTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("read_file");
      expect(schema.function.parameters.required).toContain("file_path");
    });

    it("should have name matching schema", () => {
      const tool = new ReadFileTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("WriteFileTool", () => {
    it("should write content to file", async () => {
      const tool = new WriteFileTool();
      jest.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined);

      const result = await tool.execute({
        file_path: "/test/path/to/file.txt",
        content: "new content",
      });

      expect(result).toContain("Successfully wrote to /test/path/to/file.txt");
      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        "/test/path/to/file.txt",
        "new content",
        "utf-8",
      );
    });

    it("should reject paths with control characters", async () => {
      const tool = new WriteFileTool();

      await expect(
        tool.execute({
          file_path: "/test/file\x00.txt",
          content: "malicious content",
        }),
      ).rejects.toThrow("Invalid path: contains control characters");
    });

    it("should throw user-friendly error when directory not found", async () => {
      const tool = new WriteFileTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      jest.mocked(mockFsPromises.writeFile).mockRejectedValue(error);

      await expect(
        tool.execute({
          file_path: "/test/nonexistent/dir/file.txt",
          content: "content",
        }),
      ).rejects.toThrow("Directory not found for file");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new WriteFileTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      jest.mocked(mockFsPromises.writeFile).mockRejectedValue(error);

      await expect(
        tool.execute({
          file_path: "/test/protected/file.txt",
          content: "content",
        }),
      ).rejects.toThrow("Permission denied");
    });

    it("should have correct schema", () => {
      const tool = new WriteFileTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("write_file");
      expect(schema.function.parameters.required).toContain("file_path");
      expect(schema.function.parameters.required).toContain("content");
    });

    it("should have name matching schema", () => {
      const tool = new WriteFileTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("createDefaultToolRegistry", () => {
    it("should register all 9 built-in tools", () => {
      const registry = createDefaultToolRegistry();
      const allTools = registry.getToolNames();

      expect(allTools).toHaveLength(9);
      expect(allTools).toContain("read_file");
      expect(allTools).toContain("write_file");
      expect(allTools).toContain("list_dir");
      expect(allTools).toContain("mkdir");
      expect(allTools).toContain("remove");
      expect(allTools).toContain("move");
      expect(allTools).toContain("search_text");
      expect(allTools).toContain("search_files");
      expect(allTools).toContain("run_bash");
    });

    it("should enable 7 tools by default", () => {
      const registry = createDefaultToolRegistry();
      const schemas = registry.getEnabledSchemas();

      expect(schemas).toHaveLength(7);

      const enabledNames = schemas.map((schema: any) => schema.function.name);
      expect(enabledNames).toContain("read_file");
      expect(enabledNames).toContain("write_file");
      expect(enabledNames).toContain("list_dir");
      expect(enabledNames).toContain("mkdir");
      expect(enabledNames).toContain("move");
      expect(enabledNames).toContain("search_text");
      expect(enabledNames).toContain("search_files");
    });

    it("should disable remove and run_bash by default", () => {
      const registry = createDefaultToolRegistry();

      expect(registry.hasTool("remove")).toBe(true);
      expect(registry.hasTool("run_bash")).toBe(true);

      expect(registry.isToolEnabled("remove")).toBe(false);
      expect(registry.isToolEnabled("run_bash")).toBe(false);
    });

    it("should allow enabling disabled tools", () => {
      const registry = createDefaultToolRegistry();

      registry.enable("remove");
      expect(registry.isToolEnabled("remove")).toBe(true);

      registry.enable("run_bash");
      expect(registry.isToolEnabled("run_bash")).toBe(true);

      expect(registry.getEnabledSchemas()).toHaveLength(9);
    });

    it("should register tools that are executable", async () => {
      jest.mocked(mockFsPromises.readFile).mockResolvedValue("test content");

      const registry = createDefaultToolRegistry();

      const result = await registry.execute("read_file", {
        file_path: "/test/file.txt",
      });

      expect(result).not.toContain("Error executing");
      expect(result).not.toContain("Tool not found");
    });

    it("should reject execution of disabled tools", async () => {
      const registry = createDefaultToolRegistry();

      const result = await registry.execute("remove", {
        path: "/test/file.txt",
      });

      expect(result).toBe("Tool not available: remove");
    });
  });
});
