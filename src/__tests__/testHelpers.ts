import { Agent } from "../agent.js";
import type { LLMProvider } from "../providers/interface.js";
import type { ChatRequest, ChatChunk } from "../providers/types.js";
import type { ProvidersConfig } from "../providers/config.js";
import type { ExecutableTool } from "../tools/interface.js";
import type { ChatTool } from "../providers/types.js";

export const testProvidersConfig: ProvidersConfig = {
  default: "local-ollama",
  providers: [
    {
      name: "local-ollama",
      type: "ollama",
      models: [
        {
          name: "Llama 3.2 3B",
          key: "llama3.2:3b",
          contextWindowTokens: 128_000,
        },
        {
          name: "Llama 3.2 90B",
          key: "llama3.2:90b",
          contextWindowTokens: 128_000,
        },
      ],
      defaultModel: "llama3.2:3b",
      host: "http://localhost:11434",
    },
    {
      name: "bedrock",
      type: "bedrock",
      models: [
        {
          name: "Claude 3.5 Sonnet",
          key: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          contextWindowTokens: 128_000,
        },
      ],
      defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      region: "us-west-2",
    },
  ],
};

export function createMockWriteStream(): NodeJS.WriteStream & {
  chunks: string[];
} {
  const chunks: string[] = [];

  return {
    chunks,
    columns: 80,
    isTTY: false,
    write: (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WriteStream & { chunks: string[] };
}

export function createTestAgent(
  provider: LLMProvider,
  config?: Partial<ConstructorParameters<typeof Agent>[0]>,
): Agent {
  const agent = new Agent({ providersConfig: testProvidersConfig, ...config });
  (agent as any).provider = provider;
  return agent;
}

export class ToolCallMockProvider implements LLMProvider {
  readonly name = "mock-tool-call";
  readonly streamChatCalls: ChatRequest[] = [];
  private readonly toolName: string;

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  getCapabilities() {
    return { contextWindowTokens: 128000 };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.streamChatCalls.push(request);
    if (this.streamChatCalls.length === 1) {
      yield {
        delta: "",
        toolCalls: [
          {
            id: `call-${this.toolName}-1`,
            function: {
              name: this.toolName,
              arguments: { index: this.streamChatCalls.length },
            },
          },
        ],
      };
    } else {
      yield { delta: `Final answer after ${this.toolName}.` };
    }
  }
}

export function createMockTool(options: {
  name: string;
  description?: string;
  execute?: (args: Record<string, unknown>) => Promise<string>;
}): ExecutableTool {
  const schema: ChatTool = {
    type: "function",
    function: {
      name: options.name,
      description: options.description ?? options.name,
      parameters: { type: "object", properties: {} },
    },
  };

  return {
    name: options.name,
    description: options.description ?? options.name,
    getSchema: () => schema,
    execute: options.execute ?? (() => Promise.resolve("ok")),
  };
}
