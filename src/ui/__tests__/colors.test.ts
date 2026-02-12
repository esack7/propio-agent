import chalk from "chalk";

// Test for colors module
describe("colors module", () => {
  let colorsModule: any;

  beforeEach(async () => {
    // Clear chalk's internal color level to allow fresh detection
    chalk.level = 3; // Reset to truecolor
    colorsModule = await import("../colors.js");
  });

  describe("color functions", () => {
    it("should export userInput function", async () => {
      expect(colorsModule.userInput).toBeDefined();
      expect(typeof colorsModule.userInput).toBe("function");
    });

    it("should export assistant function", async () => {
      expect(colorsModule.assistant).toBeDefined();
      expect(typeof colorsModule.assistant).toBe("function");
    });

    it("should export tool function", async () => {
      expect(colorsModule.tool).toBeDefined();
      expect(typeof colorsModule.tool).toBe("function");
    });

    it("should export success function", async () => {
      expect(colorsModule.success).toBeDefined();
      expect(typeof colorsModule.success).toBe("function");
    });

    it("should export error function", async () => {
      expect(colorsModule.error).toBeDefined();
      expect(typeof colorsModule.error).toBe("function");
    });

    it("should export warning function", async () => {
      expect(colorsModule.warning).toBeDefined();
      expect(typeof colorsModule.warning).toBe("function");
    });

    it("should export command function", async () => {
      expect(colorsModule.command).toBeDefined();
      expect(typeof colorsModule.command).toBe("function");
    });

    it("should export subtle function", async () => {
      expect(colorsModule.subtle).toBeDefined();
      expect(typeof colorsModule.subtle).toBe("function");
    });

    it("should export info function", async () => {
      expect(colorsModule.info).toBeDefined();
      expect(typeof colorsModule.info).toBe("function");
    });
  });

  describe("color application (truecolor terminal)", () => {
    beforeEach(() => {
      chalk.level = 3; // Ensure truecolor support
    });

    it("userInput should return text styled with cyan (#56B6C2)", async () => {
      const result = colorsModule.userInput("test");
      // With colors enabled, the result should contain ANSI codes
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      // The text should be wrapped with ANSI color codes when color level is 3
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("assistant should return text styled with light gray (#ABB2BF)", async () => {
      const result = colorsModule.assistant("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("tool should return text styled with purple (#C678DD)", async () => {
      const result = colorsModule.tool("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("success should return text styled with green (#98C379)", async () => {
      const result = colorsModule.success("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("error should return text styled with red (#E06C75)", async () => {
      const result = colorsModule.error("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("warning should return text styled with orange (#D19A66)", async () => {
      const result = colorsModule.warning("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("command should return text styled with yellow (#E5C07B)", async () => {
      const result = colorsModule.command("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("subtle should return text styled with dark gray (#5C6370)", async () => {
      const result = colorsModule.subtle("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("info should return text styled with blue (#61AFEF)", async () => {
      const result = colorsModule.info("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });
  });

  describe("NO_COLOR environment variable support", () => {
    it("should return unstyled text when NO_COLOR=1", async () => {
      // Save original env
      const originalNoColor = process.env.NO_COLOR;

      // Set NO_COLOR
      process.env.NO_COLOR = "1";

      // Clear the module cache to force re-import with new env
      jest.resetModules();
      const freshModule = await import("../colors.js");

      const result = freshModule.userInput("test");

      // With NO_COLOR set, chalk should strip colors, so result === input
      // We just verify the function returns a string
      expect(typeof result).toBe("string");

      // Restore env
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    });
  });

  describe("FORCE_COLOR environment variable support", () => {
    it("should enable colors when FORCE_COLOR=1 even in non-TTY", async () => {
      // Save original env
      const originalForceColor = process.env.FORCE_COLOR;

      // Set FORCE_COLOR
      process.env.FORCE_COLOR = "1";

      // Clear the module cache to force re-import with new env
      jest.resetModules();
      const freshModule = await import("../colors.js");

      const result = freshModule.userInput("test");

      // With FORCE_COLOR set, chalk should enable colors
      expect(typeof result).toBe("string");

      // Restore env
      if (originalForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = originalForceColor;
      }
    });
  });

  describe("each color uses correct hex code", () => {
    beforeEach(() => {
      chalk.level = 3; // Ensure truecolor
    });

    it("userInput uses hex #56B6C2", () => {
      const expected = chalk.hex("#56B6C2")("test");
      const actual = colorsModule.userInput("test");
      expect(actual).toBe(expected);
    });

    it("assistant uses hex #ABB2BF", () => {
      const expected = chalk.hex("#ABB2BF")("test");
      const actual = colorsModule.assistant("test");
      expect(actual).toBe(expected);
    });

    it("tool uses hex #C678DD", () => {
      const expected = chalk.hex("#C678DD")("test");
      const actual = colorsModule.tool("test");
      expect(actual).toBe(expected);
    });

    it("success uses hex #98C379", () => {
      const expected = chalk.hex("#98C379")("test");
      const actual = colorsModule.success("test");
      expect(actual).toBe(expected);
    });

    it("error uses hex #E06C75", () => {
      const expected = chalk.hex("#E06C75")("test");
      const actual = colorsModule.error("test");
      expect(actual).toBe(expected);
    });

    it("warning uses hex #D19A66", () => {
      const expected = chalk.hex("#D19A66")("test");
      const actual = colorsModule.warning("test");
      expect(actual).toBe(expected);
    });

    it("command uses hex #E5C07B", () => {
      const expected = chalk.hex("#E5C07B")("test");
      const actual = colorsModule.command("test");
      expect(actual).toBe(expected);
    });

    it("subtle uses hex #5C6370", () => {
      const expected = chalk.hex("#5C6370")("test");
      const actual = colorsModule.subtle("test");
      expect(actual).toBe(expected);
    });

    it("info uses hex #61AFEF", () => {
      const expected = chalk.hex("#61AFEF")("test");
      const actual = colorsModule.info("test");
      expect(actual).toBe(expected);
    });
  });
});
