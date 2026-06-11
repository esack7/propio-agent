import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { showModelMenu } from "../modelMenu.js";
import { createMockMenuUi, MockPromptComposer } from "./menuTestHelpers.js";
import { loadProvidersConfig } from "../../config/providersConfig.js";
import type { ProvidersConfig } from "@propio-ai/providers";

class MockAgent {
  readonly switchCalls: Array<{ providerName: string; modelKey?: string }> = [];
  private selection = {
    providerName: "openrouter",
    modelKey: "model-a",
  };

  getActiveModelSelection() {
    return { ...this.selection };
  }

  switchProvider(providerName: string, modelKey?: string): void {
    this.switchCalls.push({ providerName, modelKey });
    this.selection = {
      providerName,
      modelKey: modelKey ?? this.selection.modelKey,
    };
  }
}

function createConfigFile(): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-model-menu-"));
  return {
    dir,
    filePath: path.join(dir, "providers.json"),
  };
}

function writeConfig(filePath: string): void {
  const config: ProvidersConfig = {
    default: "openrouter",
    providers: [
      {
        name: "openrouter",
        type: "openrouter",
        models: [
          { name: "Model A", key: "model-a", contextWindowTokens: 128_000 },
          { name: "Model B", key: "model-b", contextWindowTokens: 128_000 },
        ],
        defaultModel: "model-a",
      },
      {
        name: "bedrock",
        type: "bedrock",
        models: [
          { name: "Claude", key: "claude", contextWindowTokens: 128_000 },
        ],
        defaultModel: "claude",
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
}

function expectOpenRouterModelSwitch(agent: MockAgent): void {
  expect(agent.switchCalls).toEqual([
    { providerName: "openrouter", modelKey: "model-b" },
  ]);
}

function expectPersistedOpenRouterDefault(
  filePath: string,
  defaultModel: string,
): void {
  const saved = loadProvidersConfig(filePath);
  expect(saved.default).toBe("openrouter");
  expect(saved.providers[0].defaultModel).toBe(defaultModel);
}

describe("showModelMenu", () => {
  let outputLines: string[];
  let ui: {
    command: (text: string) => void;
    error: (text: string) => void;
    info: (text: string) => void;
    prompt: (text: string) => string;
    section: (text: string) => void;
    success: (text: string) => void;
  };

  beforeEach(() => {
    outputLines = [];
    ui = createMockMenuUi(outputLines);
  });

  async function withModelMenu(
    responses: Array<string | null>,
    assertions: (context: {
      agent: MockAgent;
      composer: MockPromptComposer;
      filePath: string;
      output: string;
    }) => Promise<void> | void,
  ): Promise<void> {
    const { dir, filePath } = createConfigFile();
    const agent = new MockAgent();
    const composer = new MockPromptComposer(responses);

    try {
      writeConfig(filePath);
      await showModelMenu(composer, agent as any, ui as any, filePath);
      await assertions({
        agent,
        composer,
        filePath,
        output: outputLines.join("\n"),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  afterEach(() => {
    for (const line of outputLines) {
      expect(typeof line).toBe("string");
    }
  });

  it("shows the current session and persisted default selections", async () => {
    await withModelMenu([""], ({ output }) => {
      expect(output).toContain("Current session: openrouter/model-a");
      expect(output).toContain(
        "Default for future sessions: openrouter/model-a",
      );
      expect(output).toContain("Providers");
      expect(output).toContain("openrouter");
      expect(output).toContain("bedrock");
    });
  });

  it("switches only the current session when requested", async () => {
    await withModelMenu(["1", "2", "1"], ({ agent, filePath }) => {
      expectOpenRouterModelSwitch(agent);
      expectPersistedOpenRouterDefault(filePath, "model-a");
    });
  });

  it("skips the model prompt when the provider has only one configured model", async () => {
    await withModelMenu(["2", "1"], ({ agent, composer }) => {
      expect(agent.switchCalls).toEqual([
        { providerName: "bedrock", modelKey: "claude" },
      ]);
      expect(composer.prompts).toEqual([
        "Enter provider number or blank to cancel: ",
        "Enter 1, 2, or blank to cancel: ",
      ]);
    });
  });

  it("persists the selection and switches the current session", async () => {
    await withModelMenu(["1", "2", "2"], ({ agent, filePath }) => {
      expectOpenRouterModelSwitch(agent);
      expectPersistedOpenRouterDefault(filePath, "model-b");
    });
  });

  it("cancels cleanly on blank input", async () => {
    await withModelMenu([""], ({ agent }) => {
      expect(agent.switchCalls).toEqual([]);
    });
  });
});
