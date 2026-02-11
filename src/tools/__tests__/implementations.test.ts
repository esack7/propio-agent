import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { ReadFileTool, WriteFileTool } from "../fileSystem";
import { SaveSessionContextTool } from "../sessionContext";
import { createDefaultToolRegistry } from "../factory";
import { ToolContext } from "../types";
import { ChatMessage } from "../../providers/types";

// Mock fs modules
jest.mock("fs");
jest.mock("fs/promises");
const mockFs = fs as jest.Mocked<typeof fs>;
const mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;

describe("Tool Implementations", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock process.cwd() to return "/test" so test paths under /test are valid
    process.cwd = jest.fn(() => "/test");
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  describe("ReadFileTool", () => {
    it("should read file and return content", async () => {
      const tool = new ReadFileTool();
      const mockContent = "file content here";
      mockFsPromises.readFile.mockResolvedValue(mockContent);

      const result = await tool.execute({ file_path: "/test/path/to/file.txt" });

      expect(result).toBe(mockContent);
      expect(mockFsPromises.readFile).toHaveBeenCalledWith(
        "/test/path/to/file.txt",
        "utf-8",
      );
    });

    it("should reject paths outside allowed directory", async () => {
      const tool = new ReadFileTool();

      await expect(
        tool.execute({ file_path: "/../etc/passwd" })
      ).rejects.toThrow("Access denied");
    });

    it("should throw user-friendly error for non-existent file", async () => {
      const tool = new ReadFileTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFsPromises.readFile.mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/missing.txt" })
      ).rejects.toThrow("File not found");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new ReadFileTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFsPromises.readFile.mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/protected.txt" })
      ).rejects.toThrow("Permission denied");
    });

    it("should throw user-friendly error when path is a directory", async () => {
      const tool = new ReadFileTool();
      const error = new Error("EISDIR") as NodeJS.ErrnoException;
      error.code = "EISDIR";
      mockFsPromises.readFile.mockRejectedValue(error);

      await expect(
        tool.execute({ file_path: "/test/path/to/dir" })
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
      mockFsPromises.writeFile.mockResolvedValue(undefined);

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

    it("should reject paths outside allowed directory", async () => {
      const tool = new WriteFileTool();

      await expect(
        tool.execute({
          file_path: "/../etc/passwd",
          content: "malicious content",
        })
      ).rejects.toThrow("Access denied");
    });

    it("should throw user-friendly error when directory not found", async () => {
      const tool = new WriteFileTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFsPromises.writeFile.mockRejectedValue(error);

      await expect(
        tool.execute({
          file_path: "/test/nonexistent/dir/file.txt",
          content: "content",
        })
      ).rejects.toThrow("Directory not found for file");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new WriteFileTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFsPromises.writeFile.mockRejectedValue(error);

      await expect(
        tool.execute({
          file_path: "/test/protected/file.txt",
          content: "content",
        })
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

  describe("SaveSessionContextTool", () => {
    it("should write context to file using ToolContext", async () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test system prompt",
        sessionContext: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
        sessionContextFilePath: "/path/to/session.txt",
      };

      const tool = new SaveSessionContextTool(mockContext);
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = await tool.execute({ reason: "test save" });

      expect(result).toContain(
        "Successfully saved session context to /path/to/session.txt",
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/session.txt",
        expect.stringContaining("Test system prompt"),
        "utf-8",
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/session.txt",
        expect.stringContaining("Hello"),
        "utf-8",
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/session.txt",
        expect.stringContaining("Hi there"),
        "utf-8",
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/session.txt",
        expect.stringContaining("Reason: test save"),
        "utf-8",
      );
    });

    it("should read live context values via property getters", async () => {
      // Create a mutable state object to simulate agent state
      let currentSystemPrompt = "Initial prompt";
      let currentSessionContext: ChatMessage[] = [
        { role: "user", content: "First message" },
      ];

      // Create context with property getters
      const mockContext: ToolContext = {
        get systemPrompt() {
          return currentSystemPrompt;
        },
        get sessionContext() {
          return currentSessionContext;
        },
        sessionContextFilePath: "/path/to/session.txt",
      };

      const tool = new SaveSessionContextTool(mockContext);
      mockFs.writeFileSync.mockImplementation(() => {});

      // First execution
      await tool.execute({ reason: "first save" });
      const firstCall = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(firstCall).toContain("Initial prompt");
      expect(firstCall).toContain("First message");

      // Simulate state change (like setSystemPrompt() or adding messages)
      currentSystemPrompt = "Updated prompt";
      currentSessionContext = [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Second message" },
      ];

      // Second execution - should reflect updated state
      await tool.execute({ reason: "second save" });
      const secondCall = mockFs.writeFileSync.mock.calls[1][1] as string;
      expect(secondCall).toContain("Updated prompt");
      expect(secondCall).toContain("Second message");
      expect(secondCall).not.toContain("Initial prompt");
    });

    it("should have correct schema", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };
      const tool = new SaveSessionContextTool(mockContext);
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("save_session_context");
      expect(schema.function.parameters.properties).toHaveProperty("reason");
    });

    it("should have name matching schema", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };
      const tool = new SaveSessionContextTool(mockContext);
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("createDefaultToolRegistry", () => {
    it("should register all 10 built-in tools", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);
      const allTools = registry.getToolNames();

      expect(allTools).toHaveLength(10);
      expect(allTools).toContain("read_file");
      expect(allTools).toContain("write_file");
      expect(allTools).toContain("save_session_context");
      expect(allTools).toContain("list_dir");
      expect(allTools).toContain("mkdir");
      expect(allTools).toContain("remove");
      expect(allTools).toContain("move");
      expect(allTools).toContain("search_text");
      expect(allTools).toContain("search_files");
      expect(allTools).toContain("run_bash");
    });

    it("should enable 8 tools by default", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);
      const schemas = registry.getEnabledSchemas();

      expect(schemas).toHaveLength(8);

      const enabledNames = schemas.map((schema) => schema.function.name);
      expect(enabledNames).toContain("read_file");
      expect(enabledNames).toContain("write_file");
      expect(enabledNames).toContain("save_session_context");
      expect(enabledNames).toContain("list_dir");
      expect(enabledNames).toContain("mkdir");
      expect(enabledNames).toContain("move");
      expect(enabledNames).toContain("search_text");
      expect(enabledNames).toContain("search_files");
    });

    it("should disable remove and run_bash by default", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);

      // Both tools should be registered
      expect(registry.hasTool("remove")).toBe(true);
      expect(registry.hasTool("run_bash")).toBe(true);

      // But not enabled
      expect(registry.isToolEnabled("remove")).toBe(false);
      expect(registry.isToolEnabled("run_bash")).toBe(false);
    });

    it("should allow enabling disabled tools", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);

      // Enable remove
      registry.enable("remove");
      expect(registry.isToolEnabled("remove")).toBe(true);

      // Enable run_bash
      registry.enable("run_bash");
      expect(registry.isToolEnabled("run_bash")).toBe(true);

      // Should now have 10 enabled tools
      expect(registry.getEnabledSchemas()).toHaveLength(10);
    });

    it("should register tools that are executable", async () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };
      mockFsPromises.readFile.mockResolvedValue("test content");

      const registry = createDefaultToolRegistry(mockContext);

      // Execute read_file tool
      const result = await registry.execute("read_file", {
        file_path: "/test/file.txt",
      });

      // Should not return an error message
      expect(result).not.toContain("Error executing");
      expect(result).not.toContain("Tool not found");
    });

    it("should reject execution of disabled tools", async () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);

      // Try to execute disabled remove tool
      const result = await registry.execute("remove", {
        path: "/test/file.txt",
      });

      expect(result).toBe("Tool not available: remove");
    });
  });
});
