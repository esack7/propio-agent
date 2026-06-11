import * as path from "path";
import * as os from "os";
import {
  getConfigPath,
  loadProvidersConfig,
  loadProvidersConfigAsync,
} from "../providersConfig.js";

describe("Providers Config", () => {
  describe("getConfigPath()", () => {
    it("should return path to ~/.propio/providers.json", () => {
      const configPath = getConfigPath();
      expect(configPath).toContain(".propio");
      expect(configPath).toContain("providers.json");
    });

    it("should return an absolute path", () => {
      const configPath = getConfigPath();
      expect(path.isAbsolute(configPath)).toBe(true);
    });

    it("should use user home directory", () => {
      const configPath = getConfigPath();
      const homeDir = os.homedir();
      expect(configPath).toContain(homeDir);
    });

    it("should construct path with correct separators", () => {
      const configPath = getConfigPath();
      const expectedPath = path.join(os.homedir(), ".propio", "providers.json");
      expect(configPath).toBe(expectedPath);
    });
  });

  describe("missing-config guidance", () => {
    const missingPath = path.join(
      os.tmpdir(),
      "propio-missing-config",
      "providers.json",
    );

    it("should point users at ~/.propio/providers.json when file is missing", () => {
      expect(() => loadProvidersConfig(missingPath)).toThrow(
        /Please create ~\/\.propio\/providers\.json/,
      );
    });

    it("should use the same guidance for the async loader", async () => {
      await expect(loadProvidersConfigAsync(missingPath)).rejects.toThrow(
        /See README for configuration examples/,
      );
    });
  });
});
