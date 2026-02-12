// For ESM modules, use unstable_mockModule instead of jest.mock
jest.unstable_mockModule("fs/promises", () => ({
  readdir: jest.fn(),
  mkdir: jest.fn(),
  rm: jest.fn(),
  rename: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

// Dynamic imports for modules under test
let ListDirTool: any;
let MkdirTool: any;
let RemoveTool: any;
let MoveTool: any;
let mockFsPromises: jest.Mocked<any>;

beforeAll(async () => {
  const fsPromises = await import("fs/promises");
  mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;

  const fileSystemModule = await import("../fileSystem.js");
  ListDirTool = fileSystemModule.ListDirTool;
  MkdirTool = fileSystemModule.MkdirTool;
  RemoveTool = fileSystemModule.RemoveTool;
  MoveTool = fileSystemModule.MoveTool;
});

describe("New Filesystem Tools", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock process.cwd() to return "/test" so test paths under /test are valid
    process.cwd = jest.fn(() => "/test");
  });

  afterEach(() => {
    process.cwd = originalCwd;
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

      const result = await tool.execute({ path: "/test/empty/dir" });

      expect(result).toBe("Directory is empty");
    });

    it("should reject paths outside allowed directory", async () => {
      const tool = new ListDirTool();

      await expect(tool.execute({ path: "/../etc" })).rejects.toThrow(
        "Access denied",
      );
    });

    it("should throw user-friendly error for non-existent directory", async () => {
      const tool = new ListDirTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFsPromises.readdir.mockRejectedValue(error);

      await expect(tool.execute({ path: "/test/missing/dir" })).rejects.toThrow(
        "Directory not found",
      );
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new ListDirTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFsPromises.readdir.mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/protected/dir" }),
      ).rejects.toThrow("Permission denied");
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

    it("should reject paths outside allowed directory", async () => {
      const tool = new MkdirTool();

      await expect(tool.execute({ path: "/../etc/malicious" })).rejects.toThrow(
        "Access denied",
      );
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new MkdirTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFsPromises.mkdir.mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/protected/dir" }),
      ).rejects.toThrow("Permission denied");
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

    it("should reject paths outside allowed directory", async () => {
      const tool = new RemoveTool();

      await expect(tool.execute({ path: "/../etc/passwd" })).rejects.toThrow(
        "Access denied",
      );
    });

    it("should throw user-friendly error for non-existent path", async () => {
      const tool = new RemoveTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFsPromises.rm.mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/missing/file.txt" }),
      ).rejects.toThrow("Path not found");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new RemoveTool();
      const error = new Error("EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      mockFsPromises.rm.mockRejectedValue(error);

      await expect(
        tool.execute({ path: "/test/protected/file.txt" }),
      ).rejects.toThrow("Permission denied");
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

    it("should reject source path outside allowed directory", async () => {
      const tool = new MoveTool();

      await expect(
        tool.execute({
          path: "/../etc/passwd",
          dest: "/test/dest.txt",
        }),
      ).rejects.toThrow("Access denied");
    });

    it("should reject destination path outside allowed directory", async () => {
      const tool = new MoveTool();

      await expect(
        tool.execute({
          path: "/test/source.txt",
          dest: "/../etc/malicious",
        }),
      ).rejects.toThrow("Access denied");
    });

    it("should throw user-friendly error for non-existent source", async () => {
      const tool = new MoveTool();
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockFsPromises.rename.mockRejectedValue(error);

      await expect(
        tool.execute({
          path: "/test/missing/source.txt",
          dest: "/test/dest.txt",
        }),
      ).rejects.toThrow("Source path not found");
    });

    it("should throw user-friendly error for permission denied", async () => {
      const tool = new MoveTool();
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      mockFsPromises.rename.mockRejectedValue(error);

      await expect(
        tool.execute({
          path: "/test/protected/source.txt",
          dest: "/test/dest.txt",
        }),
      ).rejects.toThrow("Permission denied for move operation");
    });

    it("should throw user-friendly error for cross-filesystem move", async () => {
      const tool = new MoveTool();
      const error = new Error("EXDEV") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      mockFsPromises.rename.mockRejectedValue(error);

      await expect(
        tool.execute({
          path: "/test/source.txt",
          dest: "/test/other-fs/dest.txt",
        }),
      ).rejects.toThrow("Cannot move across filesystems");
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
