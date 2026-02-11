import * as fsPromises from "fs/promises";
import { ListDirTool, MkdirTool, RemoveTool, MoveTool } from "../fileSystem";

// Mock fs/promises module
jest.mock("fs/promises");
const mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;

describe("New Filesystem Tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("ListDirTool", () => {
    it("should list directory contents with types", async () => {
      const tool = new ListDirTool();
      const mockEntries = [
        { name: "file1.txt", isDirectory: () => false },
        { name: "file2.js", isDirectory: () => false },
        { name: "subdir", isDirectory: () => true },
      ];
      mockFsPromises.readdir.mockResolvedValue(mockEntries as any);

      const result = await tool.execute({ path: "/test/dir" });

      expect(result).toContain("file: file1.txt");
      expect(result).toContain("file: file2.js");
      expect(result).toContain("directory: subdir");
      expect(mockFsPromises.readdir).toHaveBeenCalledWith("/test/dir", {
        withFileTypes: true,
      });
    });

    it("should handle empty directory", async () => {
      const tool = new ListDirTool();
      mockFsPromises.readdir.mockResolvedValue([]);

      const result = await tool.execute({ path: "/empty/dir" });

      expect(result).toBe("Directory is empty");
    });

    it("should have correct schema", () => {
      const tool = new ListDirTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("list_dir");
      expect(schema.function.parameters.required).toContain("path");
    });

    it("should have name matching schema", () => {
      const tool = new ListDirTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("MkdirTool", () => {
    it("should create directory with recursive option", async () => {
      const tool = new MkdirTool();
      mockFsPromises.mkdir.mockResolvedValue(undefined);

      const result = await tool.execute({ path: "/test/new/dir" });

      expect(result).toContain("Successfully created directory: /test/new/dir");
      expect(mockFsPromises.mkdir).toHaveBeenCalledWith("/test/new/dir", {
        recursive: true,
      });
    });

    it("should have correct schema", () => {
      const tool = new MkdirTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("mkdir");
      expect(schema.function.parameters.required).toContain("path");
    });

    it("should have name matching schema", () => {
      const tool = new MkdirTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("RemoveTool", () => {
    it("should remove file or directory", async () => {
      const tool = new RemoveTool();
      mockFsPromises.rm.mockResolvedValue(undefined);

      const result = await tool.execute({ path: "/test/file.txt" });

      expect(result).toContain("Successfully removed: /test/file.txt");
      expect(mockFsPromises.rm).toHaveBeenCalledWith("/test/file.txt", {
        recursive: true,
        force: true,
      });
    });

    it("should have correct schema with warning", () => {
      const tool = new RemoveTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("remove");
      expect(schema.function.description).toContain("WARNING");
      expect(schema.function.parameters.required).toContain("path");
    });

    it("should have name matching schema", () => {
      const tool = new RemoveTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("MoveTool", () => {
    it("should move file from source to destination", async () => {
      const tool = new MoveTool();
      mockFsPromises.rename.mockResolvedValue(undefined);

      const result = await tool.execute({
        path: "/test/source.txt",
        dest: "/test/dest.txt",
      });

      expect(result).toContain(
        "Successfully moved /test/source.txt to /test/dest.txt",
      );
      expect(mockFsPromises.rename).toHaveBeenCalledWith(
        "/test/source.txt",
        "/test/dest.txt",
      );
    });

    it("should have correct schema", () => {
      const tool = new MoveTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("move");
      expect(schema.function.parameters.required).toContain("path");
      expect(schema.function.parameters.required).toContain("dest");
    });

    it("should have name matching schema", () => {
      const tool = new MoveTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });
});
