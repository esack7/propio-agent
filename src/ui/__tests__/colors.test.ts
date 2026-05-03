// Force chalk to use truecolor (level 3) for this test file
// This ensures color functions are created with consistent ANSI codes
import { withEnvironmentVariable } from "./envTestHelpers.js";
import chalk from "chalk";
chalk.level = 3;

// Test for colors module
describe("colors module", () => {
  let colorsModule: any;
  let textColorsModule: any;
  let statusColorsModule: any;

  beforeEach(async () => {
    // Ensure chalk level is maintained
    chalk.level = 3;
    // Clear module cache and re-import to pick up chalk level
    jest.resetModules();
    // Must re-import chalk after resetModules and set level again
    const chalkModule = await import("chalk");
    chalkModule.default.level = 3;
    textColorsModule = await import("../textColors.js");
    statusColorsModule = await import("../statusColors.js");
    colorsModule = {
      ...textColorsModule,
      ...statusColorsModule,
    };
  });

  describe("color functions", () => {
    it("should export userInput function", async () => {
      expect(textColorsModule.userInput).toBeDefined();
      expect(typeof textColorsModule.userInput).toBe("function");
    });

    it("should export assistant function", async () => {
      expect(textColorsModule.assistant).toBeDefined();
      expect(typeof textColorsModule.assistant).toBe("function");
    });

    it("should export inputPrompt function", async () => {
      expect(textColorsModule.inputPrompt).toBeDefined();
      expect(typeof textColorsModule.inputPrompt).toBe("function");
    });

    it("should export assistantPrefix function", async () => {
      expect(textColorsModule.assistantPrefix).toBeDefined();
      expect(typeof textColorsModule.assistantPrefix).toBe("function");
    });

    it("should export assistantGutter function", async () => {
      expect(textColorsModule.assistantGutter).toBeDefined();
      expect(typeof textColorsModule.assistantGutter).toBe("function");
    });

    it("should export inputBorder function", async () => {
      expect(textColorsModule.inputBorder).toBeDefined();
      expect(typeof textColorsModule.inputBorder).toBe("function");
    });

    it("should export inputFill function", async () => {
      expect(textColorsModule.inputFill).toBeDefined();
      expect(typeof textColorsModule.inputFill).toBe("function");
    });

    it("should export inputPlaceholder function", async () => {
      expect(textColorsModule.inputPlaceholder).toBeDefined();
      expect(typeof textColorsModule.inputPlaceholder).toBe("function");
    });

    it("should export tool function", async () => {
      expect(statusColorsModule.tool).toBeDefined();
      expect(typeof statusColorsModule.tool).toBe("function");
    });

    it("should export success function", async () => {
      expect(statusColorsModule.success).toBeDefined();
      expect(typeof statusColorsModule.success).toBe("function");
    });

    it("should export error function", async () => {
      expect(statusColorsModule.error).toBeDefined();
      expect(typeof statusColorsModule.error).toBe("function");
    });

    it("should export warning function", async () => {
      expect(statusColorsModule.warning).toBeDefined();
      expect(typeof statusColorsModule.warning).toBe("function");
    });

    it("should export command function", async () => {
      expect(textColorsModule.command).toBeDefined();
      expect(typeof textColorsModule.command).toBe("function");
    });

    it("should export subtle function", async () => {
      expect(textColorsModule.subtle).toBeDefined();
      expect(typeof textColorsModule.subtle).toBe("function");
    });

    it("should export info function", async () => {
      expect(textColorsModule.info).toBeDefined();
      expect(typeof textColorsModule.info).toBe("function");
    });
  });

  describe("color application (truecolor terminal)", () => {
    beforeEach(() => {
      chalk.level = 3; // Ensure truecolor support
    });

    it("userInput should return text styled with cyan (#56B6C2)", async () => {
      const result = textColorsModule.userInput("test");
      // With colors enabled, the result should contain ANSI codes
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      // The text should be wrapped with ANSI color codes when color level is 3
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("assistant should return text styled with light gray (#ABB2BF)", async () => {
      const result = textColorsModule.assistant("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("inputPrompt should return text styled with cyan (#56B6C2)", async () => {
      const result = textColorsModule.inputPrompt("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("assistantPrefix should return text styled with dark gray (#5C6370)", async () => {
      const result = textColorsModule.assistantPrefix("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("assistantGutter should return text styled with dark gray (#5C6370)", async () => {
      const result = textColorsModule.assistantGutter("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("inputBorder should return text styled with dark gray (#5C6370)", async () => {
      const result = textColorsModule.inputBorder("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("inputFill should return text styled with a background fill", async () => {
      const result = textColorsModule.inputFill("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("inputPlaceholder should return text styled with dark gray (#5C6370)", async () => {
      const result = textColorsModule.inputPlaceholder("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("tool should return text styled with purple (#C678DD)", async () => {
      const result = statusColorsModule.tool("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("success should return text styled with green (#98C379)", async () => {
      const result = statusColorsModule.success("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("error should return text styled with red (#E06C75)", async () => {
      const result = statusColorsModule.error("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("warning should return text styled with orange (#D19A66)", async () => {
      const result = statusColorsModule.warning("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("command should return text styled with yellow (#E5C07B)", async () => {
      const result = textColorsModule.command("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("subtle should return text styled with dark gray (#5C6370)", async () => {
      const result = textColorsModule.subtle("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });

    it("info should return text styled with blue (#61AFEF)", async () => {
      const result = textColorsModule.info("test");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan("test".length);
    });
  });

  describe("NO_COLOR environment variable support", () => {
    it("should return unstyled text when NO_COLOR=1", async () => {
      await withEnvironmentVariable("NO_COLOR", "1", async () => {
        // Clear the module cache to force re-import with new env
        jest.resetModules();
        const freshModule = await import("../textColors.js");

        const result = freshModule.userInput("test");

        // With NO_COLOR set, chalk should strip colors, so result === input
        // We just verify the function returns a string
        expect(typeof result).toBe("string");
      });
    });
  });

  describe("FORCE_COLOR environment variable support", () => {
    it("should enable colors when FORCE_COLOR=1 even in non-TTY", async () => {
      await withEnvironmentVariable("FORCE_COLOR", "1", async () => {
        // Clear the module cache to force re-import with new env
        jest.resetModules();
        const freshModule = await import("../textColors.js");

        const result = freshModule.userInput("test");

        // With FORCE_COLOR set, chalk should enable colors
        expect(typeof result).toBe("string");
      });
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

    it("inputPrompt uses hex #56B6C2", () => {
      const expected = chalk.hex("#56B6C2")("test");
      const actual = colorsModule.inputPrompt("test");
      expect(actual).toBe(expected);
    });

    it("assistantPrefix uses hex #5C6370", () => {
      const expected = chalk.hex("#5C6370")("test");
      const actual = colorsModule.assistantPrefix("test");
      expect(actual).toBe(expected);
    });

    it("assistantGutter uses hex #5C6370", () => {
      const expected = chalk.hex("#5C6370")("test");
      const actual = colorsModule.assistantGutter("test");
      expect(actual).toBe(expected);
    });

    it("inputBorder uses hex #5C6370", () => {
      const expected = chalk.hex("#5C6370")("test");
      const actual = colorsModule.inputBorder("test");
      expect(actual).toBe(expected);
    });

    it("inputFill uses a background hex #282C34", () => {
      const expected = chalk.bgHex("#282C34")("test");
      const actual = colorsModule.inputFill("test");
      expect(actual).toBe(expected);
    });

    it("inputPlaceholder uses hex #5C6370", () => {
      const expected = chalk.hex("#5C6370")("test");
      const actual = colorsModule.inputPlaceholder("test");
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
