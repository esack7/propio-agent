import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../agent';
import { LLMProvider } from '../providers/interface';
import { ChatRequest, ChatResponse, ChatChunk, ChatMessage } from '../providers/types';
import { ProvidersConfig } from '../providers/config';

/**
 * Mock LLM Provider for testing
 */
class MockProvider implements LLMProvider {
  name = 'mock';
  chatCalls: ChatRequest[] = [];
  streamChatCalls: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.chatCalls.push(request);
    return {
      message: {
        role: 'assistant',
        content: 'Mock response'
      },
      stopReason: 'end_turn'
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.streamChatCalls.push(request);
    yield { delta: 'Mock ' };
    yield { delta: 'stream' };
  }
}

// Test providers config
const testProvidersConfig: ProvidersConfig = {
  default: 'local-ollama',
  providers: [
    {
      name: 'local-ollama',
      type: 'ollama',
      models: [
        { name: 'Llama 3.2 3B', key: 'llama3.2:3b' },
        { name: 'Llama 3.2 90B', key: 'llama3.2:90b' }
      ],
      defaultModel: 'llama3.2:3b',
      host: 'http://localhost:11434'
    },
    {
      name: 'bedrock',
      type: 'bedrock',
      models: [{ name: 'Claude 3.5 Sonnet', key: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
      defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: 'us-west-2'
    }
  ]
};

describe('Agent with Multi-Provider Configuration', () => {
  const tempDir = '/tmp/agent-tests';

  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Constructor with ProvidersConfig object', () => {
    it('should require providersConfig parameter', () => {
      expect(() => new Agent()).toThrow(/providersConfig|required/i);
    });

    it('should accept ProvidersConfig object', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent).toBeDefined();
    });

    it('should accept ProvidersConfig with default provider', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(agent).toBeDefined();
      expect((agent as any).provider).toBeDefined();
    });

    it('should accept optional providerName to override default', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        providerName: 'bedrock'
      });
      expect(agent).toBeDefined();
    });

    it('should accept optional modelKey to override defaultModel', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: 'llama3.2:90b'
      });
      expect(agent).toBeDefined();
    });

    it('should accept systemPrompt and sessionContextFilePath options', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        systemPrompt: 'Custom prompt',
        sessionContextFilePath: path.join(tempDir, 'session.txt')
      });
      expect(agent).toBeDefined();
    });

    it('should throw error if providerName does not exist', () => {
      expect(() => {
        new Agent({
          providersConfig: testProvidersConfig,
          providerName: 'nonexistent'
        });
      }).toThrow(/unknown.*provider|not found/i);
    });

    it('should throw error if modelKey does not exist in provider', () => {
      expect(() => {
        new Agent({
          providersConfig: testProvidersConfig,
          modelKey: 'nonexistent-model'
        });
      }).toThrow(/invalid.*model|not found|unknown model/i);
    });
  });

  describe('Constructor with file path', () => {
    it('should accept file path string as providersConfig', () => {
      const configPath = path.join(tempDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(testProvidersConfig));

      const agent = new Agent({ providersConfig: configPath });
      expect(agent).toBeDefined();
    });

    it('should load config from file and use default provider', () => {
      const configPath = path.join(tempDir, 'config-default.json');
      fs.writeFileSync(configPath, JSON.stringify(testProvidersConfig));

      const agent = new Agent({ providersConfig: configPath });
      expect(agent).toBeDefined();
    });

    it('should throw error if file does not exist', () => {
      const configPath = path.join(tempDir, 'nonexistent.json');
      expect(() => {
        new Agent({ providersConfig: configPath });
      }).toThrow(/not found|ENOENT/i);
    });

    it('should throw error if file contains invalid JSON', () => {
      const configPath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(configPath, '{ invalid }');

      expect(() => {
        new Agent({ providersConfig: configPath });
      }).toThrow(/JSON|parse|invalid/i);
    });
  });

  describe('Provider Resolution', () => {
    it('should use default provider when not specified', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      // Default is 'local-ollama'
      expect(agent).toBeDefined();
      expect((agent as any).provider).toBeDefined();
    });

    it('should use specified provider when providerName provided', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        providerName: 'bedrock'
      });
      expect(agent).toBeDefined();
    });

    it('should store providersConfig for runtime switching', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect((agent as any).providersConfig).toBeDefined();
      expect((agent as any).providersConfig).toEqual(testProvidersConfig);
    });
  });

  describe('Model Resolution', () => {
    it('should use defaultModel when modelKey not provided', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect((agent as any).model).toBe('llama3.2:3b');
    });

    it('should use specified modelKey when provided', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: 'llama3.2:90b'
      });
      expect((agent as any).model).toBe('llama3.2:90b');
    });

    it('should validate modelKey belongs to provider', () => {
      const config: ProvidersConfig = {
        default: 'ollama',
        providers: [
          {
            name: 'ollama',
            type: 'ollama',
            models: [{ name: 'Model A', key: 'model-a' }],
            defaultModel: 'model-a'
          }
        ]
      };

      expect(() => {
        new Agent({
          providersConfig: config,
          modelKey: 'nonexistent'
        });
      }).toThrow(/invalid.*model|not found/i);
    });
  });

  describe('switchProvider() method', () => {
    it('should accept providerName to switch providers', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const originalProvider = (agent as any).provider;

      expect(() => {
        (agent as any).switchProvider('bedrock');
      }).not.toThrow();

      const newProvider = (agent as any).provider;
      expect(newProvider).toBeDefined();
    });

    it('should accept optional modelKey to override provider defaultModel', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider('local-ollama', 'llama3.2:90b');
      }).not.toThrow();

      expect((agent as any).model).toBe('llama3.2:90b');
    });

    it('should use provider defaultModel when modelKey not provided', () => {
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: 'llama3.2:90b'
      });

      (agent as any).switchProvider('bedrock');

      expect((agent as any).model).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    });

    it('should preserve session context when switching provider', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.chat('First message');
      const contextBefore = agent.getContext();

      (agent as any).switchProvider('bedrock');

      const contextAfter = agent.getContext();
      expect(contextAfter.length).toBe(contextBefore.length);
      expect(contextAfter).toEqual(contextBefore);
    });

    it('should throw error for invalid provider name', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider('nonexistent');
      }).toThrow(/unknown.*provider|not found/i);
    });

    it('should throw error for invalid modelKey in target provider', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });

      expect(() => {
        (agent as any).switchProvider('bedrock', 'invalid-model');
      }).toThrow(/invalid.*model|not found/i);
    });

    it('should not modify provider on validation error', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      const originalProvider = (agent as any).provider;

      try {
        (agent as any).switchProvider('nonexistent');
      } catch (e) {
        // Expected to throw
      }

      expect((agent as any).provider).toBe(originalProvider);
    });
  });

  describe('Chat Integration with New Config', () => {
    it('should pass resolved model to provider in chat', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      expect(mockProvider.chatCalls[0].model).toBe('llama3.2:3b');
    });

    it('should pass correct model when modelKey override is used', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({
        providersConfig: testProvidersConfig,
        modelKey: 'llama3.2:90b'
      });
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      expect(mockProvider.chatCalls[0].model).toBe('llama3.2:90b');
    });

    it('should maintain all existing chat functionality', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.chat('Test message');

      expect(typeof response).toBe('string');
      expect(response).toBe('Mock response');
      expect(mockProvider.chatCalls).toHaveLength(1);
    });
  });

  describe('Stream Integration with New Config', () => {
    it('should pass resolved model to provider in streamChat', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      await agent.streamChat('Test', () => {});

      expect(mockProvider.streamChatCalls[0].model).toBe('llama3.2:3b');
    });

    it('should maintain all existing streamChat functionality', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      const response = await agent.streamChat('Test', (token) => tokens.push(token));

      expect(typeof response).toBe('string');
      expect(tokens.length).toBeGreaterThan(0);
    });
  });

  describe('Backward Compatibility', () => {
    it('should keep chat() signature unchanged', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.chat('Test');
      expect(typeof response).toBe('string');
    });

    it('should keep streamChat() signature unchanged', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({ providersConfig: testProvidersConfig });
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat('Test', () => {});
      expect(typeof response).toBe('string');
    });

    it('should keep context management methods unchanged', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(typeof agent.clearContext).toBe('function');
      expect(typeof agent.getContext).toBe('function');
      expect(typeof agent.setSystemPrompt).toBe('function');
    });

    it('should keep tool management methods unchanged', () => {
      const agent = new Agent({ providersConfig: testProvidersConfig });
      expect(typeof agent.getTools).toBe('function');
      expect(typeof agent.saveContext).toBe('function');
    });
  });
});
