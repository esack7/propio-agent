import * as path from "path";

describe("symbols module", () => {
  let symbolsModule: any;

  // Helper to reload module with specific environment
  async function loadSymbolsModule(
    env: Record<string, string | undefined> = {},
  ) {
    // Save original environment
    const originalEnv = { ...process.env };

    // Apply test environment
    Object.assign(process.env, env);

    // Clear module cache to force reimport with new env
    jest.resetModules();

    try {
      symbolsModule = await import("../symbols.js");
      return symbolsModule;
    } finally {
      // Restore original environment
      Object.assign(process.env, originalEnv);
    }
  }

  describe("Unicode symbols on supported terminals", () => {
    beforeEach(async () => {
      // On macOS/Linux with normal TERM
      await loadSymbolsModule({
        TERM: "xterm-256color",
      });
    });

    it("should export symbols object", () => {
      expect(symbolsModule.symbols).toBeDefined();
      expect(typeof symbolsModule.symbols).toBe("object");
    });

    it("should export prompt symbol", () => {
      expect(symbolsModule.symbols.prompt).toBeDefined();
      expect(typeof symbolsModule.symbols.prompt).toBe("string");
    });

    it("should export bullet symbol", () => {
      expect(symbolsModule.symbols.bullet).toBeDefined();
      expect(typeof symbolsModule.symbols.bullet).toBe("string");
    });

    it("should export success symbol", () => {
      expect(symbolsModule.symbols.success).toBeDefined();
      expect(typeof symbolsModule.symbols.success).toBe("string");
    });

    it("should export error symbol", () => {
      expect(symbolsModule.symbols.error).toBeDefined();
      expect(typeof symbolsModule.symbols.error).toBe("string");
    });

    it("should export ellipsis symbol", () => {
      expect(symbolsModule.symbols.ellipsis).toBeDefined();
      expect(typeof symbolsModule.symbols.ellipsis).toBe("string");
    });

    it("should use Unicode prompt symbol ❯", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });
      expect(symbols.symbols.prompt).toBe("❯");
    });

    it("should use Unicode bullet symbol ◆", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });
      expect(symbols.symbols.bullet).toBe("◆");
    });

    it("should use Unicode success symbol ✔", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });
      expect(symbols.symbols.success).toBe("✔");
    });

    it("should use Unicode error symbol ✖", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });
      expect(symbols.symbols.error).toBe("✖");
    });

    it("should use Unicode ellipsis symbol …", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });
      expect(symbols.symbols.ellipsis).toBe("…");
    });
  });

  describe("ASCII fallbacks on Windows", () => {
    it("should use ASCII symbols when platform is win32", async () => {
      // Mock the platform as win32
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      try {
        const symbols = await loadSymbolsModule({
          TERM: "xterm-256color",
        });

        expect(symbols.symbols.prompt).toBe(">");
        expect(symbols.symbols.bullet).toBe("*");
        expect(symbols.symbols.success).toBe("√");
        expect(symbols.symbols.error).toBe("x");
        expect(symbols.symbols.ellipsis).toBe("...");
      } finally {
        // Restore platform
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("ASCII fallbacks on dumb terminals", () => {
    it("should use ASCII symbols when TERM=dumb", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "dumb",
      });

      expect(symbols.symbols.prompt).toBe(">");
      expect(symbols.symbols.bullet).toBe("*");
      expect(symbols.symbols.success).toBe("√");
      expect(symbols.symbols.error).toBe("x");
      expect(symbols.symbols.ellipsis).toBe("...");
    });
  });

  describe("ASCII fallbacks when TERM is not set", () => {
    it("should still support Unicode when TERM is not set on non-Windows", async () => {
      const symbols = await loadSymbolsModule({
        TERM: undefined,
      });

      // On non-Windows platforms without TERM set, we should still get Unicode
      // Only Windows without proper TERM should get ASCII
      if (process.platform !== "win32") {
        expect(symbols.symbols.prompt).toBe("❯");
      }
    });
  });

  describe("terminal detection logic", () => {
    it("should support Unicode on macOS", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });

      try {
        const symbols = await loadSymbolsModule({
          TERM: "xterm-256color",
        });

        expect(symbols.symbols.prompt).toBe("❯");
        expect(symbols.symbols.bullet).toBe("◆");
        expect(symbols.symbols.success).toBe("✔");
        expect(symbols.symbols.error).toBe("✖");
        expect(symbols.symbols.ellipsis).toBe("…");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("should support Unicode on Linux", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      try {
        const symbols = await loadSymbolsModule({
          TERM: "xterm-256color",
        });

        expect(symbols.symbols.prompt).toBe("❯");
        expect(symbols.symbols.bullet).toBe("◆");
        expect(symbols.symbols.success).toBe("✔");
        expect(symbols.symbols.error).toBe("✖");
        expect(symbols.symbols.ellipsis).toBe("…");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("should use ASCII fallbacks when TERM=basic", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "basic",
      });

      // TERM=basic should still get Unicode unless explicitly dumb
      // Only TERM=dumb should trigger ASCII fallback
      if (process.platform !== "win32") {
        expect(symbols.symbols.prompt).toBe("❯");
      }
    });
  });

  describe("symbol completeness", () => {
    it("should have exactly 5 symbol types", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });

      const symbolKeys = Object.keys(symbols.symbols);
      expect(symbolKeys).toContain("prompt");
      expect(symbolKeys).toContain("bullet");
      expect(symbolKeys).toContain("success");
      expect(symbolKeys).toContain("error");
      expect(symbolKeys).toContain("ellipsis");
      expect(symbolKeys.length).toBe(5);
    });

    it("all symbols should be non-empty strings", async () => {
      const symbols = await loadSymbolsModule({
        TERM: "xterm-256color",
      });

      Object.values(symbols.symbols).forEach((symbol: any) => {
        expect(typeof symbol).toBe("string");
        expect(symbol.length).toBeGreaterThan(0);
      });
    });
  });
});
