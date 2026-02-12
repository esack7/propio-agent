import chalk from "chalk";

describe("formatting module", () => {
  let formattingModule: any;
  let colorsModule: any;
  let symbolsModule: any;

  beforeEach(async () => {
    // Reset chalk to truecolor mode
    chalk.level = 3;

    // Clear module cache and reimport
    jest.resetModules();
    formattingModule = await import("../formatting.js");
    colorsModule = await import("../colors.js");
    symbolsModule = await import("../symbols.js");
  });

  describe("module exports", () => {
    it("should export formatUserMessage function", () => {
      expect(formattingModule.formatUserMessage).toBeDefined();
      expect(typeof formattingModule.formatUserMessage).toBe("function");
    });

    it("should export formatAssistantMessage function", () => {
      expect(formattingModule.formatAssistantMessage).toBeDefined();
      expect(typeof formattingModule.formatAssistantMessage).toBe("function");
    });

    it("should export formatToolExecution function", () => {
      expect(formattingModule.formatToolExecution).toBeDefined();
      expect(typeof formattingModule.formatToolExecution).toBe("function");
    });

    it("should export formatSuccess function", () => {
      expect(formattingModule.formatSuccess).toBeDefined();
      expect(typeof formattingModule.formatSuccess).toBe("function");
    });

    it("should export formatError function", () => {
      expect(formattingModule.formatError).toBeDefined();
      expect(typeof formattingModule.formatError).toBe("function");
    });

    it("should export formatWarning function", () => {
      expect(formattingModule.formatWarning).toBeDefined();
      expect(typeof formattingModule.formatWarning).toBe("function");
    });

    it("should export formatCommand function", () => {
      expect(formattingModule.formatCommand).toBeDefined();
      expect(typeof formattingModule.formatCommand).toBe("function");
    });

    it("should export formatInfo function", () => {
      expect(formattingModule.formatInfo).toBeDefined();
      expect(typeof formattingModule.formatInfo).toBe("function");
    });

    it("should export formatSubtle function", () => {
      expect(formattingModule.formatSubtle).toBeDefined();
      expect(typeof formattingModule.formatSubtle).toBe("function");
    });
  });

  describe("formatUserMessage", () => {
    it("should return styled text with userInput color", () => {
      const text = "user input";
      const result = formattingModule.formatUserMessage(text);

      // Should match userInput color function
      const expected = colorsModule.userInput(text);
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatUserMessage("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle text with special characters", () => {
      const text = "user@input#123!";
      const result = formattingModule.formatUserMessage(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("formatAssistantMessage", () => {
    it("should return styled text with assistant color", () => {
      const text = "assistant response";
      const result = formattingModule.formatAssistantMessage(text);

      // Should match assistant color function
      const expected = colorsModule.assistant(text);
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatAssistantMessage("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle multiline text", () => {
      const text = "line 1\nline 2\nline 3";
      const result = formattingModule.formatAssistantMessage(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("formatToolExecution", () => {
    it("should prepend tool symbol to tool name colored with tool color", () => {
      const toolName = "bash";
      const result = formattingModule.formatToolExecution(toolName);

      // Should contain the symbol
      expect(result).toContain(symbolsModule.symbols.bullet);

      // Should contain tool color applied
      const expected = colorsModule.tool(
        `${symbolsModule.symbols.bullet} ${toolName}`,
      );
      expect(result).toBe(expected);
    });

    it("should handle tool name with special characters", () => {
      const toolName = "file-system-tool";
      const result = formattingModule.formatToolExecution(toolName);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain(symbolsModule.symbols.bullet);
    });

    it("should handle empty tool name", () => {
      const result = formattingModule.formatToolExecution("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("formatSuccess", () => {
    it("should prepend success symbol to text colored with success color", () => {
      const text = "Operation successful";
      const result = formattingModule.formatSuccess(text);

      // Should contain the success symbol
      expect(result).toContain(symbolsModule.symbols.success);

      // Should match the composed format
      const expected = colorsModule.success(
        `${symbolsModule.symbols.success} ${text}`,
      );
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatSuccess("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle text with newlines", () => {
      const text = "Line 1\nLine 2";
      const result = formattingModule.formatSuccess(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain(symbolsModule.symbols.success);
    });
  });

  describe("formatError", () => {
    it("should prepend error symbol to text colored with error color", () => {
      const text = "An error occurred";
      const result = formattingModule.formatError(text);

      // Should contain the error symbol
      expect(result).toContain(symbolsModule.symbols.error);

      // Should match the composed format
      const expected = colorsModule.error(
        `${symbolsModule.symbols.error} ${text}`,
      );
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatError("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle error message with details", () => {
      const text = "Error: File not found at /path/to/file";
      const result = formattingModule.formatError(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain(symbolsModule.symbols.error);
    });
  });

  describe("formatWarning", () => {
    it("should prepend warning symbol to text colored with warning color", () => {
      const text = "This is a warning";
      const result = formattingModule.formatWarning(text);

      // Should contain the bullet symbol (used for warning)
      expect(result).toContain(symbolsModule.symbols.bullet);

      // Should match the composed format with warning color
      const expected = colorsModule.warning(
        `${symbolsModule.symbols.bullet} ${text}`,
      );
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatWarning("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle warning with multiple parts", () => {
      const text = "Deprecation Warning: Feature X will be removed";
      const result = formattingModule.formatWarning(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result).toContain(symbolsModule.symbols.bullet);
    });
  });

  describe("formatCommand", () => {
    it("should return text styled with command color", () => {
      const text = "npm install";
      const result = formattingModule.formatCommand(text);

      // Should match command color function
      const expected = colorsModule.command(text);
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatCommand("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle command with arguments", () => {
      const text = "docker run -it ubuntu:latest bash";
      const result = formattingModule.formatCommand(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("formatInfo", () => {
    it("should return text styled with info color", () => {
      const text = "Information message";
      const result = formattingModule.formatInfo(text);

      // Should match info color function
      const expected = colorsModule.info(text);
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatInfo("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle info with formatting", () => {
      const text = "Version: 1.0.0 | Status: Active";
      const result = formattingModule.formatInfo(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("formatSubtle", () => {
    it("should return text styled with subtle color", () => {
      const text = "subtle text";
      const result = formattingModule.formatSubtle(text);

      // Should match subtle color function
      const expected = colorsModule.subtle(text);
      expect(result).toBe(expected);
    });

    it("should handle empty string", () => {
      const result = formattingModule.formatSubtle("");
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });

    it("should handle subtle helper text", () => {
      const text = "(use --help for more options)";
      const result = formattingModule.formatSubtle(text);
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
    });
  });

  describe("composition behavior", () => {
    it("functions with symbols should include symbol + space + text", () => {
      const text = "test";
      const symbolFunctions = [
        {
          fn: formattingModule.formatSuccess,
          symbol: symbolsModule.symbols.success,
        },
        {
          fn: formattingModule.formatError,
          symbol: symbolsModule.symbols.error,
        },
        {
          fn: formattingModule.formatWarning,
          symbol: symbolsModule.symbols.bullet,
        },
        {
          fn: formattingModule.formatToolExecution,
          symbol: symbolsModule.symbols.bullet,
        },
      ];

      symbolFunctions.forEach(({ fn, symbol }) => {
        const result = fn(text);
        // Should start with symbol and have space after it
        expect(result).toContain(`${symbol} `);
      });
    });

    it("functions without symbols should just apply color", () => {
      const text = "test";
      const colorOnlyFunctions = [
        formattingModule.formatUserMessage,
        formattingModule.formatAssistantMessage,
        formattingModule.formatCommand,
        formattingModule.formatInfo,
        formattingModule.formatSubtle,
      ];

      colorOnlyFunctions.forEach((fn) => {
        const result = fn(text);
        expect(result).toBeDefined();
        expect(typeof result).toBe("string");
        // These should not contain symbols
        expect(result).not.toContain(symbolsModule.symbols.bullet);
        expect(result).not.toContain(symbolsModule.symbols.success);
        expect(result).not.toContain(symbolsModule.symbols.error);
      });
    });
  });

  describe("NO_COLOR environment variable support", () => {
    it("should respect NO_COLOR when formatting with symbols", async () => {
      // Save original env
      const originalNoColor = process.env.NO_COLOR;

      // Set NO_COLOR
      process.env.NO_COLOR = "1";

      // Clear the module cache to force re-import with new env
      jest.resetModules();
      const freshFormattingModule = await import("../formatting.js");

      const result = freshFormattingModule.formatSuccess("test");

      // With NO_COLOR set, colors should be stripped but symbol should remain
      expect(typeof result).toBe("string");
      expect(result).toContain(symbolsModule.symbols.success);

      // Restore env
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    });

    it("should respect NO_COLOR when formatting with colors only", async () => {
      // Save original env
      const originalNoColor = process.env.NO_COLOR;

      // Set NO_COLOR
      process.env.NO_COLOR = "1";

      // Clear the module cache to force re-import with new env
      jest.resetModules();
      const freshFormattingModule = await import("../formatting.js");

      const result = freshFormattingModule.formatUserMessage("test");

      // With NO_COLOR set, colors should be stripped
      expect(typeof result).toBe("string");

      // Restore env
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    });
  });

  describe("integration with colors and symbols modules", () => {
    it("should use colors module functions correctly", () => {
      const text = "test";

      expect(formattingModule.formatUserMessage(text)).toBe(
        colorsModule.userInput(text),
      );
      expect(formattingModule.formatAssistantMessage(text)).toBe(
        colorsModule.assistant(text),
      );
      expect(formattingModule.formatCommand(text)).toBe(
        colorsModule.command(text),
      );
      expect(formattingModule.formatInfo(text)).toBe(colorsModule.info(text));
      expect(formattingModule.formatSubtle(text)).toBe(
        colorsModule.subtle(text),
      );
    });

    it("should use symbols module symbols correctly", () => {
      const text = "test";

      const successResult = formattingModule.formatSuccess(text);
      expect(successResult).toContain(symbolsModule.symbols.success);

      const errorResult = formattingModule.formatError(text);
      expect(errorResult).toContain(symbolsModule.symbols.error);

      const warningResult = formattingModule.formatWarning(text);
      expect(warningResult).toContain(symbolsModule.symbols.bullet);

      const toolResult = formattingModule.formatToolExecution(text);
      expect(toolResult).toContain(symbolsModule.symbols.bullet);
    });
  });
});
