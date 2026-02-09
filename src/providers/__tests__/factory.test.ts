import { createProvider, extractModelFromConfig } from '../factory';
import { LLMProvider } from '../interface';
import { ProviderConfig, OllamaProviderConfig, BedrockProviderConfig } from '../config';
import { OllamaProvider } from '../ollama';
import { BedrockProvider } from '../bedrock';

describe('Provider Factory', () => {
  describe('createProvider', () => {
    it('should create OllamaProvider from new config shape', () => {
      const config: OllamaProviderConfig = {
        name: 'local-ollama',
        type: 'ollama',
        models: [{ name: 'Llama', key: 'llama3.2' }],
        defaultModel: 'llama3.2',
        host: 'http://localhost:11434'
      };

      const provider = createProvider(config);

      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.name).toBe('ollama');
    });

    it('should create BedrockProvider from new config shape', () => {
      const config: BedrockProviderConfig = {
        name: 'bedrock',
        type: 'bedrock',
        models: [{ name: 'Claude', key: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
        defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-west-2'
      };

      const provider = createProvider(config);

      expect(provider).toBeInstanceOf(BedrockProvider);
      expect(provider.name).toBe('bedrock');
    });

    it('should accept modelKey parameter and use it instead of defaultModel', () => {
      const config: OllamaProviderConfig = {
        name: 'local-ollama',
        type: 'ollama',
        models: [
          { name: 'Llama 3B', key: 'llama3.2:3b' },
          { name: 'Llama 90B', key: 'llama3.2:90b' }
        ],
        defaultModel: 'llama3.2:3b',
        host: 'http://localhost:11434'
      };

      const provider = createProvider(config, 'llama3.2:90b');

      expect(provider).toBeInstanceOf(OllamaProvider);
    });

    it('should return LLMProvider interface type', () => {
      const config: OllamaProviderConfig = {
        name: 'ollama',
        type: 'ollama',
        models: [{ name: 'Llama', key: 'llama3.2' }],
        defaultModel: 'llama3.2'
      };

      const provider = createProvider(config);

      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe('function');
      expect(typeof provider.streamChat).toBe('function');
      expect(provider.name).toBeDefined();
    });

    it('should throw error for unknown provider type', () => {
      const config: any = {
        name: 'test',
        type: 'unknown',
        models: [{ name: 'Test', key: 'test' }],
        defaultModel: 'test'
      };

      expect(() => createProvider(config)).toThrow();
    });

    it('should include valid providers in error message', () => {
      const config: any = {
        name: 'test',
        type: 'unknown',
        models: [{ name: 'Test', key: 'test' }],
        defaultModel: 'test'
      };

      expect(() => createProvider(config)).toThrow(/ollama.*bedrock|bedrock.*ollama/);
    });

    it('should use flat host field for Ollama', () => {
      const config: OllamaProviderConfig = {
        name: 'ollama',
        type: 'ollama',
        models: [{ name: 'Llama', key: 'llama3.2' }],
        defaultModel: 'llama3.2',
        host: 'http://custom.host:11434'
      };

      const provider = createProvider(config);
      expect(provider).toBeInstanceOf(OllamaProvider);
    });

    it('should use flat region field for Bedrock', () => {
      const config: BedrockProviderConfig = {
        name: 'bedrock',
        type: 'bedrock',
        models: [{ name: 'Claude', key: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
        defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'eu-west-1'
      };

      const provider = createProvider(config);
      expect(provider).toBeInstanceOf(BedrockProvider);
    });
  });

  describe('extractModelFromConfig', () => {
    it('should return defaultModel from Ollama config', () => {
      const config: OllamaProviderConfig = {
        name: 'ollama',
        type: 'ollama',
        models: [{ name: 'Llama', key: 'llama3.2' }],
        defaultModel: 'llama3.2'
      };

      const model = extractModelFromConfig(config);

      expect(model).toBe('llama3.2');
    });

    it('should return defaultModel from Bedrock config', () => {
      const config: BedrockProviderConfig = {
        name: 'bedrock',
        type: 'bedrock',
        models: [{ name: 'Claude', key: 'anthropic.claude-3-5-sonnet-20241022-v2:0' }],
        defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
      };

      const model = extractModelFromConfig(config);

      expect(model).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    });

    it('should work for any provider type', () => {
      const config: ProviderConfig = {
        name: 'test',
        type: 'ollama',
        models: [{ name: 'Test', key: 'test-model' }],
        defaultModel: 'test-model'
      };

      const model = extractModelFromConfig(config);

      expect(model).toBe('test-model');
    });
  });
});
