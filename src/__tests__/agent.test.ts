import { Agent } from '../agent';
import { LLMProvider } from '../providers/interface';
import { ChatRequest, ChatResponse, ChatChunk, ChatMessage } from '../providers/types';

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

describe('Agent with Provider Abstraction', () => {
  describe('Provider Configuration', () => {
    it('should initialize with default Ollama provider', () => {
      const agent = new Agent();
      expect(agent).toBeDefined();
    });

    it('should accept provider configuration', () => {
      const agent = new Agent({
        providerConfig: {
          provider: 'ollama',
          ollama: {
            model: 'custom-model'
          }
        }
      });
      expect(agent).toBeDefined();
    });

    it('should support systemPrompt and sessionContextFilePath options', () => {
      const agent = new Agent({
        systemPrompt: 'Custom prompt',
        sessionContextFilePath: '/tmp/session.txt'
      });
      expect(agent).toBeDefined();
    });
  });

  describe('Provider Usage in Chat', () => {
    it('should build ChatRequest with system message', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      // We'll need to expose setProvider for testing
      (agent as any).provider = mockProvider;

      await agent.chat('Hello');

      expect(mockProvider.chatCalls).toHaveLength(1);
      const request = mockProvider.chatCalls[0];
      expect(request.messages.some(m => m.role === 'system')).toBe(true);
    });

    it('should build ChatRequest with user message', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await agent.chat('Hello');

      expect(mockProvider.chatCalls).toHaveLength(1);
      const request = mockProvider.chatCalls[0];
      expect(request.messages.some(m => m.role === 'user' && m.content === 'Hello')).toBe(
        true
      );
    });

    it('should include tools in ChatRequest', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      expect(mockProvider.chatCalls).toHaveLength(1);
      const request = mockProvider.chatCalls[0];
      expect(request.tools).toBeDefined();
      expect(request.tools?.length).toBeGreaterThan(0);
    });

    it('should pass correct model to provider', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent({
        providerConfig: {
          provider: 'ollama',
          ollama: { model: 'specific-model' }
        }
      });
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      expect(mockProvider.chatCalls).toHaveLength(1);
      expect(mockProvider.chatCalls[0].model).toBe('specific-model');
    });
  });

  describe('Session Context with Provider-Agnostic Types', () => {
    it('should store messages as ChatMessage type', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await agent.chat('User message');

      const context = agent.getContext();
      expect(context).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: 'User message'
        })
      );
    });

    it('should preserve tool calls in session context', async () => {
      const mockProvider = new MockProvider();
      mockProvider.chat = async (request: ChatRequest) => ({
        message: {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [
            {
              function: { name: 'test_tool', arguments: {} }
            }
          ]
        },
        stopReason: 'tool_use'
      });

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      // Mock tool execution
      (agent as any).executeTool = () => 'Tool result';

      await agent.chat('Use tool');

      const context = agent.getContext();
      const assistantMsg = context.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg?.toolCalls).toBeDefined();
    });

    it('should add tool result messages to context', async () => {
      const mockProvider = new MockProvider();
      mockProvider.chat = async (request: ChatRequest) => ({
        message: {
          role: 'assistant',
          content: 'Calling',
          toolCalls: [
            {
              function: { name: 'test_tool', arguments: {} }
            }
          ]
        },
        stopReason: 'tool_use'
      });

      const agent = new Agent();
      (agent as any).provider = mockProvider;
      (agent as any).executeTool = () => 'Tool result';

      await agent.chat('Call tool');

      const context = agent.getContext();
      expect(context.some(m => m.role === 'tool')).toBe(true);
    });
  });

  describe('Streaming with Provider', () => {
    it('should use streamChat from provider', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      let tokensCalled = 0;
      const onToken = () => tokensCalled++;

      await agent.streamChat('Test', onToken);

      expect(mockProvider.streamChatCalls).toHaveLength(1);
    });

    it('should yield tokens from provider chunks', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const tokens: string[] = [];
      const onToken = (token: string) => tokens.push(token);

      await agent.streamChat('Test', onToken);

      expect(tokens.length).toBeGreaterThan(0);
    });

    it('should accumulate stream response', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat('Test', () => {});

      expect(response).toBe('Mock stream');
    });
  });

  describe('Provider Switching', () => {
    it('should provide switchProvider method', () => {
      const agent = new Agent();
      expect(typeof (agent as any).switchProvider).toBe('function');
    });

    it('should switch to new provider config', async () => {
      const agent = new Agent();
      const originalProvider = (agent as any).provider;

      (agent as any).switchProvider({
        provider: 'ollama',
        ollama: { model: 'new-model' }
      });

      const newProvider = (agent as any).provider;
      expect(newProvider).not.toBe(originalProvider);
    });

    it('should preserve session context when switching provider', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await agent.chat('First message');
      const contextBefore = agent.getContext();

      (agent as any).switchProvider({
        provider: 'ollama',
        ollama: { model: 'new-model' }
      });

      const contextAfter = agent.getContext();
      // Session context should remain the same length after provider switch
      expect(contextAfter.length).toBe(contextBefore.length);
    });
  });

  describe('Backward Compatibility', () => {
    it('should keep chat() signature unchanged', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const response = await agent.chat('Test');
      expect(typeof response).toBe('string');
    });

    it('should keep streamChat() signature unchanged', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const response = await agent.streamChat('Test', () => {});
      expect(typeof response).toBe('string');
    });

    it('should keep context management methods unchanged', async () => {
      const agent = new Agent();
      expect(typeof agent.clearContext).toBe('function');
      expect(typeof agent.getContext).toBe('function');
      expect(typeof agent.setSystemPrompt).toBe('function');
    });

    it('should keep tool management methods unchanged', () => {
      const agent = new Agent();
      expect(typeof agent.getTools).toBe('function');
      expect(typeof agent.saveContext).toBe('function');
    });

    it('should execute built-in tools identically to current', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const toolResult = agent.saveContext('test reason');
      expect(typeof toolResult).toBe('string');
      expect(toolResult).toContain('session context');
    });
  });

  describe('System Prompt Handling', () => {
    it('should include system prompt in requests', async () => {
      const mockProvider = new MockProvider();
      const customPrompt = 'Custom system prompt';
      const agent = new Agent({ systemPrompt: customPrompt });
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      const request = mockProvider.chatCalls[0];
      const systemMsg = request.messages.find(m => m.role === 'system');
      expect(systemMsg?.content).toBe(customPrompt);
    });

    it('should update system prompt with setSystemPrompt', async () => {
      const mockProvider = new MockProvider();
      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const newPrompt = 'New system prompt';
      agent.setSystemPrompt(newPrompt);
      await agent.chat('Test');

      const request = mockProvider.chatCalls[0];
      const systemMsg = request.messages.find(m => m.role === 'system');
      expect(systemMsg?.content).toBe(newPrompt);
    });
  });

  describe('Tool Execution with Provider Types', () => {
    it('should extract tool calls from provider response', async () => {
      const mockProvider = new MockProvider();
      let callCount = 0;
      mockProvider.chat = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: 'Calling save_session_context',
              toolCalls: [
                {
                  function: {
                    name: 'save_session_context',
                    arguments: { reason: 'test' }
                  }
                }
              ]
            },
            stopReason: 'tool_use'
          };
        }
        // Second call with no tool calls to end the loop
        return {
          message: {
            role: 'assistant',
            content: 'Done'
          },
          stopReason: 'end_turn'
        };
      };

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      const response = await agent.chat('Save context');
      expect(response).toBe('Done');
      // Verify that tool was executed by checking context has tool message
      const context = agent.getContext();
      expect(context.some(m => m.role === 'tool')).toBe(true);
    });

    it('should add tool results to context', async () => {
      const mockProvider = new MockProvider();
      mockProvider.chat = async () => ({
        message: {
          role: 'assistant',
          content: 'Calling',
          toolCalls: [
            {
              function: {
                name: 'read_file',
                arguments: { file_path: '/tmp/test.txt' }
              }
            }
          ]
        },
        stopReason: 'tool_use'
      });

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      // Mock file system
      jest.spyOn(require('fs'), 'readFileSync').mockReturnValue('File content');

      await agent.chat('Read file');

      const context = agent.getContext();
      const toolMsg = context.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
    });

    it('should enforce maxIterations limit', async () => {
      const mockProvider = new MockProvider();
      let callCount = 0;
      mockProvider.chat = async () => {
        callCount++;
        return {
          message: {
            role: 'assistant',
            content: 'Calling',
            toolCalls: [
              {
                function: { name: 'save_session_context', arguments: {} }
              }
            ]
          },
          stopReason: 'tool_use'
        };
      };

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await agent.chat('Test');

      // Should stop at maxIterations (10)
      expect(callCount).toBeLessThanOrEqual(10);
    });
  });

  describe('Error Handling', () => {
    it('should handle provider errors', async () => {
      const mockProvider = new MockProvider();
      mockProvider.chat = async () => {
        throw new Error('Provider error');
      };

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      await expect(agent.chat('Test')).rejects.toThrow();
    });

    it('should include provider name in error message', async () => {
      const mockProvider = new MockProvider();
      mockProvider.chat = async () => {
        const err = new Error('Connection failed');
        throw err;
      };

      const agent = new Agent();
      (agent as any).provider = mockProvider;

      try {
        await agent.chat('Test');
      } catch (error) {
        if (error instanceof Error) {
          expect(error.message).toContain('mock');
        }
      }
    });
  });

  describe('Provider Factory Integration', () => {
    it('should use factory to create provider from config', () => {
      const agent = new Agent({
        providerConfig: {
          provider: 'ollama',
          ollama: {
            model: 'qwen3-coder:30b'
          }
        }
      });
      expect(agent).toBeDefined();
      expect((agent as any).provider).toBeDefined();
    });

    it('should throw error when factory receives unknown provider', () => {
      expect(() => {
        new Agent({
          providerConfig: {
            provider: 'unknown',
            unknown: {}
          } as any
        });
      }).toThrow();
    });

    it('should use extractModelFromConfig to set model', () => {
      const config = {
        providerConfig: {
          provider: 'bedrock' as const,
          bedrock: {
            model: 'anthropic.claude-3-sonnet-20240229-v1:0',
            region: 'us-east-1'
          }
        }
      };

      const agent = new Agent(config);
      expect((agent as any).model).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    });

    it('should default to standard model when config has no model', () => {
      const config = {
        providerConfig: {
          provider: 'ollama' as const,
          ollama: {
            model: ''  // Empty model - should trigger fallback
          }
        }
      };

      const agent = new Agent(config);
      expect((agent as any).model).toBe('qwen3-coder:30b');
    });

    it('should not import concrete provider classes in Agent', () => {
      // This test verifies the agent.ts file doesn't directly import providers
      const agentSource = require('fs').readFileSync(require('path').join(__dirname, '../agent.ts'), 'utf-8');
      expect(agentSource).not.toContain('from \'./providers/ollama\'');
      expect(agentSource).not.toContain('from \'./providers/bedrock\'');
    });
  });
});
