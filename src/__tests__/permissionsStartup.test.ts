import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Run the CLI itself, non-interactively, with its own home directory. */
function runCli(
  home: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entry, "--no-interactive", "--plain"],
      {
        // The repository, so that tsx resolves; no tool runs in these tests.
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          // Nothing listens here: a run that got as far as the provider fails
          // differently from one stopped by its settings.
          OLLAMA_HOST: "http://127.0.0.1:9",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
    child.stdin.end("hello\n");
  });
}

describe("starting with a settings file that cannot be used", () => {
  let root: string;
  let home: string;
  let settingsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "propio-startup-"));
    home = path.join(root, "home");
    settingsPath = path.join(home, ".propio", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".propio", "providers.json"),
      JSON.stringify({
        default: "local",
        providers: [
          {
            name: "local",
            type: "ollama",
            host: "http://127.0.0.1:9",
            models: [{ name: "M", key: "m", contextWindowTokens: 8000 }],
            defaultModel: "m",
          },
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [
      "a misspelled list",
      '{"permissions":{"denny":["bash"]}}',
      /permissions: .*denny/,
    ],
    [
      "a rule that cannot be read",
      '{"permissions":{"deny":["bash("]}}',
      /permissions\.deny\.0: Invalid permission rule/,
    ],
    ["JSON that does not parse", "{ nope", /not valid JSON/],
  ])(
    "stops before the first turn on %s, naming the file and field",
    async (_label, content, detail) => {
      fs.writeFileSync(settingsPath, content);

      const { code, output } = await runCli(home);

      expect(code).toBe(1);
      expect(output).toContain(`Invalid permissions in ${settingsPath}`);
      expect(output).toMatch(detail);
      // Startup stopped; no turn began and failed (a failed turn is reported
      // as "Error: Failed to get response ...").
      expect(output).not.toContain("Error:");
      expect(output).not.toContain("Failed to get response");
    },
    60_000,
  );

  it("gets as far as the provider when the settings are usable", async () => {
    fs.writeFileSync(settingsPath, '{"permissions":{"deny":["bash"]}}');

    const { code, output } = await runCli(home);

    expect(output).not.toContain("Invalid permissions");
    // It failed at the provider, which nothing is listening for.
    expect(output).toMatch(/Provider ollama error|fetch failed|ECONNREFUSED/);
    expect(code).toBe(1);
  }, 60_000);
});
