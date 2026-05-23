import type {
  PromptComposer,
  PromptConfirmRequest,
  PromptRequest,
  PromptResult,
} from "../promptComposer.js";

export interface MockMenuUi {
  readonly command: (text: string) => void;
  readonly error: (text: string) => void;
  readonly info: (text: string) => void;
  readonly prompt: (text: string) => string;
  readonly section: (text: string) => void;
  readonly success: (text: string) => void;
}

export class MockPromptComposer implements PromptComposer {
  readonly prompts: string[] = [];

  constructor(
    private readonly responses: Array<string | null>,
    private readonly confirmErrorMessage = "confirm() is not used by this test",
  ) {}

  async compose({ promptText }: PromptRequest): Promise<PromptResult> {
    this.prompts.push(promptText);
    if (this.responses.length === 0) {
      return { status: "closed" };
    }

    const next = this.responses.shift();
    if (next === null || next === undefined) {
      return { status: "closed" };
    }

    return { status: "submitted", text: next, inputMode: "prompt" };
  }

  async confirm(_request: PromptConfirmRequest): Promise<boolean> {
    throw new Error(this.confirmErrorMessage);
  }

  getCloseReason(): "closed" | "interrupted" | null {
    return null;
  }

  getState() {
    return null;
  }

  close(): void {}
}

export function createMockMenuUi(outputLines: string[]): MockMenuUi {
  return {
    command: (text: string) => outputLines.push(text),
    error: (text: string) => outputLines.push(text),
    info: (text: string) => outputLines.push(text),
    prompt: (text: string) => text,
    section: (text: string) => outputLines.push(text),
    success: (text: string) => outputLines.push(text),
  };
}
