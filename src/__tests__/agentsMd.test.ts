import * as fs from "fs";
import * as path from "path";
import {
  discoverAgentsMdFiles,
  loadAgentsMdContent,
  composeSystemPrompt,
} from "../agentsMd.js";

describe("agentsMd", () => {
  const tempDir = "/tmp/agentsmd-tests";

  beforeAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("discoverAgentsMdFiles()", () => {
    it("should find single AGENTS.md file in working directory", () => {
      const testDir = path.join(tempDir, "single-file");
      fs.mkdirSync(testDir, { recursive: true });
      const agentsMdPath = path.join(testDir, "AGENTS.md");
      fs.writeFileSync(agentsMdPath, "Test content");

      const result = discoverAgentsMdFiles(testDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(agentsMdPath);
    });

    it("should find AGENTS.md file in ancestor directory", () => {
      const rootDir = path.join(tempDir, "ancestor-test");
      const nestedDir = path.join(rootDir, "nested", "deep");
      fs.mkdirSync(nestedDir, { recursive: true });
      const agentsMdPath = path.join(rootDir, "AGENTS.md");
      fs.writeFileSync(agentsMdPath, "Root content");

      const result = discoverAgentsMdFiles(nestedDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(agentsMdPath);
    });

    it("should find multiple AGENTS.md files at different levels in root-to-leaf order", () => {
      const rootDir = path.join(tempDir, "multi-level");
      const midDir = path.join(rootDir, "packages");
      const leafDir = path.join(midDir, "api");
      fs.mkdirSync(leafDir, { recursive: true });

      const rootAgentsMd = path.join(rootDir, "AGENTS.md");
      const midAgentsMd = path.join(midDir, "AGENTS.md");
      const leafAgentsMd = path.join(leafDir, "AGENTS.md");

      fs.writeFileSync(rootAgentsMd, "Root instructions");
      fs.writeFileSync(midAgentsMd, "Package instructions");
      fs.writeFileSync(leafAgentsMd, "API instructions");

      const result = discoverAgentsMdFiles(leafDir);

      expect(result).toHaveLength(3);
      expect(result[0]).toBe(rootAgentsMd);
      expect(result[1]).toBe(midAgentsMd);
      expect(result[2]).toBe(leafAgentsMd);
    });

    it("should return empty array when no AGENTS.md files found", () => {
      const testDir = path.join(tempDir, "no-agents-md");
      fs.mkdirSync(testDir, { recursive: true });

      const result = discoverAgentsMdFiles(testDir);

      expect(result).toEqual([]);
    });

    it("should default to process.cwd() when no start directory provided", () => {
      const result = discoverAgentsMdFiles();

      expect(Array.isArray(result)).toBe(true);
    });

    it("should use custom start directory when provided", () => {
      const customDir = path.join(tempDir, "custom-start");
      fs.mkdirSync(customDir, { recursive: true });
      const agentsMdPath = path.join(customDir, "AGENTS.md");
      fs.writeFileSync(agentsMdPath, "Custom content");

      const result = discoverAgentsMdFiles(customDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(agentsMdPath);
    });

    it("should stop at filesystem root", () => {
      const testDir = path.join(tempDir, "root-stop");
      fs.mkdirSync(testDir, { recursive: true });

      const result = discoverAgentsMdFiles(testDir);

      // Should not throw or infinite loop
      expect(Array.isArray(result)).toBe(true);
    });

    it("should match filename case-sensitively (AGENTS.md only)", () => {
      const testDir = path.join(tempDir, "case-sensitive");
      fs.mkdirSync(testDir, { recursive: true });

      // Create files with different cases
      fs.writeFileSync(path.join(testDir, "AGENTS.md"), "Correct");
      fs.writeFileSync(path.join(testDir, "agents.md"), "Wrong case");
      fs.writeFileSync(path.join(testDir, "Agents.md"), "Wrong case");

      const result = discoverAgentsMdFiles(testDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(path.join(testDir, "AGENTS.md"));
    });
  });

  describe("loadAgentsMdContent()", () => {
    it("should load single file with source heading", () => {
      const testFile = path.join(tempDir, "load-single.md");
      fs.writeFileSync(testFile, "Single file content");

      const result = loadAgentsMdContent([testFile]);

      expect(result).toContain("## Project Instructions (from");
      expect(result).toContain(testFile);
      expect(result).toContain("Single file content");
    });

    it("should merge multiple files in order with source headings", () => {
      const file1 = path.join(tempDir, "load-multi-1.md");
      const file2 = path.join(tempDir, "load-multi-2.md");
      fs.writeFileSync(file1, "First file content");
      fs.writeFileSync(file2, "Second file content");

      const result = loadAgentsMdContent([file1, file2]);

      expect(result).toContain("## Project Instructions (from");
      expect(result).toContain(file1);
      expect(result).toContain("First file content");
      expect(result).toContain(file2);
      expect(result).toContain("Second file content");

      // Verify order
      const firstIndex = result.indexOf("First file content");
      const secondIndex = result.indexOf("Second file content");
      expect(firstIndex).toBeLessThan(secondIndex);
    });

    it("should return empty string for empty array", () => {
      const result = loadAgentsMdContent([]);

      expect(result).toBe("");
    });

    it("should read files with UTF-8 encoding", () => {
      const testFile = path.join(tempDir, "load-utf8.md");
      fs.writeFileSync(testFile, "Content with émojis: 🎉 and spëcial çhars", {
        encoding: "utf-8",
      });

      const result = loadAgentsMdContent([testFile]);

      expect(result).toContain("émojis: 🎉");
      expect(result).toContain("spëcial çhars");
    });
  });

  describe("composeSystemPrompt()", () => {
    it("should prepend non-empty AGENTS.md content with two-newline separator", () => {
      const agentsMdContent = "Project-specific instructions";
      const defaultPrompt = "Default system prompt";

      const result = composeSystemPrompt(agentsMdContent, defaultPrompt);

      expect(result).toBe(
        "Project-specific instructions\n\nDefault system prompt",
      );
    });

    it("should return default prompt unchanged when AGENTS.md content is empty", () => {
      const defaultPrompt = "Default system prompt";

      const result = composeSystemPrompt("", defaultPrompt);

      expect(result).toBe(defaultPrompt);
    });

    it("should handle multi-line AGENTS.md content", () => {
      const agentsMdContent = "Line 1\nLine 2\nLine 3";
      const defaultPrompt = "Default prompt";

      const result = composeSystemPrompt(agentsMdContent, defaultPrompt);

      expect(result).toBe("Line 1\nLine 2\nLine 3\n\nDefault prompt");
    });
  });
});
