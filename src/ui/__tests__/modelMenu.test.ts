import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { showModelMenu } from "../modelMenu.js";
import { loadProvidersConfig } from "../../providers/configLoader.js";
import type {
  PromptComposer,
  PromptConfirmRequest,
  PromptRequest,
  PromptResult,
} from "../promptComposer.js";
import type { ProvidersConfig } from "../../providers/config.js";

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

class MockPromptComposer implements PromptComposer {
  readonly prompts: string[] = [];

  constructor(private readonly responses: Array<string | null>) {}

  async compose({ promptText }: PromptRequest): Promise<PromptResult> {
    this.prompts.push(promptText);
    if (this.responses.length === 0) {
      return { status: "closed" };
    }

    const next = this.responses.shift();
    if (next === null || next === undefined) {
      return { status: "closed" };
    }

    return { status: "submitted", text: next };
  }

  async confirm(_request: PromptConfirmRequest): Promise<boolean> {
    throw new Error("confirm() is not used by the model menu");
  }

  getCloseReason(): "closed" | "interrupted" | null {
    return null;
  }

  getState() {
    return null;
  }

  close(): void {}
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
          { name: "Model A", key: "model-a" },
          { name: "Model B", key: "model-b" },
        ],
        defaultModel: "model-a",
      },
      {
        name: "bedrock",
        type: "bedrock",
        models: [{ name: "Claude", key: "claude" }],
        defaultModel: "claude",
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
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
    ui = {
      command: (text: string) => outputLines.push(text),
      error: (text: string) => outputLines.push(text),
      info: (text: string) => outputLines.push(text),
      prompt: (text: string) => text,
      section: (text: string) => outputLines.push(text),
      success: (text: string) => outputLines.push(text),
    };
  });

  afterEach(() => {
    for (const line of outputLines) {
      expect(typeof line).toBe("string");
    }
  });

  it("shows the current session and persisted default selections", async () => {
    const { dir, filePath } = createConfigFile();
    writeConfig(filePath);
    const agent = new MockAgent();
    const composer = new MockPromptComposer([""]);

    await showModelMenu(composer, agent as any, ui as any, filePath);

    const output = outputLines.join("\n");
    expect(output).toContain("Current session: openrouter/model-a");
    expect(output).toContain("Default for future sessions: openrouter/model-a");
    expect(output).toContain("Providers");
    expect(output).toContain("openrouter");
    expect(output).toContain("bedrock");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("switches only the current session when requested", async () => {
    const { dir, filePath } = createConfigFile();
    writeConfig(filePath);
    const agent = new MockAgent();
    const composer = new MockPromptComposer(["1", "2", "1"]);

    await showModelMenu(composer, agent as any, ui as any, filePath);

    expect(agent.switchCalls).toEqual([
      { providerName: "openrouter", modelKey: "model-b" },
    ]);

    const saved = loadProvidersConfig(filePath);
    expect(saved.default).toBe("openrouter");
    expect(saved.providers[0].defaultModel).toBe("model-a");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips the model prompt when the provider has only one configured model", async () => {
    const { dir, filePath } = createConfigFile();
    writeConfig(filePath);
    const agent = new MockAgent();
    const composer = new MockPromptComposer(["2", "1"]);

    await showModelMenu(composer, agent as any, ui as any, filePath);

    expect(agent.switchCalls).toEqual([
      { providerName: "bedrock", modelKey: "claude" },
    ]);
    expect(composer.prompts).toEqual([
      "Enter provider number or blank to cancel: ",
      "Enter 1, 2, or blank to cancel: ",
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the selection and switches the current session", async () => {
    const { dir, filePath } = createConfigFile();
    writeConfig(filePath);
    const agent = new MockAgent();
    const composer = new MockPromptComposer(["1", "2", "2"]);

    await showModelMenu(composer, agent as any, ui as any, filePath);

    expect(agent.switchCalls).toEqual([
      { providerName: "openrouter", modelKey: "model-b" },
    ]);

    const saved = loadProvidersConfig(filePath);
    expect(saved.default).toBe("openrouter");
    expect(saved.providers[0].defaultModel).toBe("model-b");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels cleanly on blank input", async () => {
    const { dir, filePath } = createConfigFile();
    writeConfig(filePath);
    const agent = new MockAgent();
    const composer = new MockPromptComposer([""]);

    await showModelMenu(composer, agent as any, ui as any, filePath);

    expect(agent.switchCalls).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
