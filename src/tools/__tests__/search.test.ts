import * as fsPromises from "fs/promises";
import fg from "fast-glob";
import { SearchTextTool, SearchFilesTool } from "../search";

// Mock dependencies
jest.mock("fs/promises");
jest.mock("fast-glob");
const mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;
const mockFg = fg as jest.MockedFunction<typeof fg>;

describe("Search Tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("SearchTextTool", () => {
    it("should find literal text matches in a file", async () => {
      const tool = new SearchTextTool();
      const mockFileContent = "line 1\nline with query\nline 3";

      mockFsPromises.stat.mockResolvedValue({
        isDirectory: () => false,
      } as any);
      mockFsPromises.readFile.mockResolvedValue(mockFileContent);

      const result = await tool.execute({
        query: "query",
        paths: ["/test/file.txt"],
        regex: false,
      });

      expect(result).toContain("/test/file.txt:2: line with query");
    });

    it("should find regex matches in a file", async () => {
      const tool = new SearchTextTool();
      const mockFileContent = "line 1\nline with test123\nline 3";

      mockFsPromises.stat.mockResolvedValue({
        isDirectory: () => false,
      } as any);
      mockFsPromises.readFile.mockResolvedValue(mockFileContent);

      const result = await tool.execute({
        query: "test\\d+",
        paths: ["/test/file.txt"],
        regex: true,
      });

      expect(result).toContain("/test/file.txt:2: line with test123");
    });

    it("should search recursively in directories", async () => {
      const tool = new SearchTextTool();
      const mockFileContent = "matching line";

      mockFsPromises.stat.mockResolvedValue({
        isDirectory: () => true,
      } as any);
      mockFg.mockResolvedValue(["/test/dir/file1.txt", "/test/dir/file2.txt"]);
      mockFsPromises.readFile.mockResolvedValue(mockFileContent);

      const result = await tool.execute({
        query: "matching",
        paths: ["/test/dir"],
        regex: false,
      });

      expect(mockFg).toHaveBeenCalled();
      expect(result).toContain("/test/dir/file1.txt:1: matching line");
      expect(result).toContain("/test/dir/file2.txt:1: matching line");
    });

    it("should return message when no matches found", async () => {
      const tool = new SearchTextTool();
      const mockFileContent = "no matching content";

      mockFsPromises.stat.mockResolvedValue({
        isDirectory: () => false,
      } as any);
      mockFsPromises.readFile.mockResolvedValue(mockFileContent);

      const result = await tool.execute({
        query: "nonexistent",
        paths: ["/test/file.txt"],
        regex: false,
      });

      expect(result).toBe("No matches found for query: nonexistent");
    });

    it("should throw error for invalid regex pattern", async () => {
      const tool = new SearchTextTool();

      await expect(
        tool.execute({
          query: "[invalid(regex",
          paths: ["/test/file.txt"],
          regex: true,
        }),
      ).rejects.toThrow("Invalid regex pattern");
    });

    it("should have correct schema", () => {
      const tool = new SearchTextTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("search_text");
      expect(schema.function.parameters.required).toContain("query");
      expect(schema.function.parameters.required).toContain("paths");
    });

    it("should have name matching schema", () => {
      const tool = new SearchTextTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });

  describe("SearchFilesTool", () => {
    it("should find files matching glob pattern", async () => {
      const tool = new SearchFilesTool();
      const mockFiles = ["/project/src/file1.ts", "/project/src/file2.ts"];

      mockFg.mockResolvedValue(mockFiles);

      const result = await tool.execute({ pattern: "src/**/*.ts" });

      expect(result).toBe("/project/src/file1.ts\n/project/src/file2.ts");
      expect(mockFg).toHaveBeenCalledWith("src/**/*.ts", {
        absolute: true,
        onlyFiles: true,
        dot: false,
      });
    });

    it("should return message when no files match", async () => {
      const tool = new SearchFilesTool();
      mockFg.mockResolvedValue([]);

      const result = await tool.execute({ pattern: "**/*.nonexistent" });

      expect(result).toBe("No files found matching pattern: **/*.nonexistent");
    });

    it("should have correct schema", () => {
      const tool = new SearchFilesTool();
      const schema = tool.getSchema();

      expect(schema.function.name).toBe("search_files");
      expect(schema.function.parameters.required).toContain("pattern");
    });

    it("should have name matching schema", () => {
      const tool = new SearchFilesTool();
      const schema = tool.getSchema();

      expect(tool.name).toBe(schema.function.name);
    });
  });
});
