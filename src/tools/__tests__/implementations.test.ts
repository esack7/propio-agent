import * as fs from "fs";
import { ReadFileTool, WriteFileTool } from "../fileSystem";
import { SaveSessionContextTool } from "../sessionContext";
import { createDefaultToolRegistry } from "../factory";
import { ToolContext } from "../types";
import { ChatMessage } from "../../providers/types";

// Mock fs module
jest.mock("fs");
const mockFs = fs as jest.Mocked<typeof fs>;

describe("Tool Implementations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("ReadFileTool", () => {
    it("should read file and return content", async () => {
      const tool = new ReadFileTool();
      const mockContent = "file content here";
      mockFs.readFileSync.mockReturnValue(mockContent);

      const result = await tool.execute({ file_path: "/path/to/file.txt" });

      expect(result).toBe(mockContent);
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/path/to/file.txt",
        "utf-8",
      );
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
      mockFs.writeFileSync.mockImplementation(() => {});

      const result = await tool.execute({
        file_path: "/path/to/file.txt",
        content: "new content",
      });

      expect(result).toContain("Successfully wrote to /path/to/file.txt");
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/path/to/file.txt",
        "new content",
        "utf-8",
      );
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
    it("should create registry with 3 tools enabled", () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };

      const registry = createDefaultToolRegistry(mockContext);
      const schemas = registry.getEnabledSchemas();

      expect(schemas).toHaveLength(3);

      const toolNames = schemas.map((schema) => schema.function.name);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("save_session_context");
    });

    it("should register tools that are executable", async () => {
      const mockContext: ToolContext = {
        systemPrompt: "Test",
        sessionContext: [],
        sessionContextFilePath: "/test",
      };
      mockFs.readFileSync.mockReturnValue("test content");

      const registry = createDefaultToolRegistry(mockContext);

      // Execute read_file tool
      const result = await registry.execute("read_file", {
        file_path: "/test/file.txt",
      });

      // Should not return an error message
      expect(result).not.toContain("Error executing");
      expect(result).not.toContain("Tool not found");
    });
  });
});
