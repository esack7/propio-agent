import { STARTUP_BANNER, printStartupBanner } from "../banner.js";

describe("banner module", () => {
  describe("STARTUP_BANNER", () => {
    it("includes A G E N T in the banner", () => {
      expect(STARTUP_BANNER).toContain("A G E N T");
    });

    it("identifies Propio (PROPIO, Propio, P R O P I O, or block-art)", () => {
      const hasPropio =
        STARTUP_BANNER.includes("PROPIO") ||
        STARTUP_BANNER.includes("Propio") ||
        STARTUP_BANNER.includes("P R O P I O") ||
        STARTUP_BANNER.includes("████");
      expect(hasPropio).toBe(true);
    });
  });

  describe("printStartupBanner", () => {
    it("renders the banner and a subtle version line", () => {
      const infoLines: string[] = [];
      const subtleLines: string[] = [];
      const ui = {
        info: (text: string) => {
          infoLines.push(text);
        },
        subtle: (text: string) => {
          subtleLines.push(text);
        },
      };

      printStartupBanner(ui, "1.2.3");

      expect(infoLines).toEqual([STARTUP_BANNER]);
      expect(subtleLines).toEqual(["                    v1.2.3"]);
    });
  });
});
