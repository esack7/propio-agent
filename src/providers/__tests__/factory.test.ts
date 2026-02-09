import { createProvider, extractModelFromConfig } from '../factory';
import { LLMProvider } from '../interface';
import { ProviderConfig } from '../config';
import { OllamaProvider } from '../ollama';
import { BedrockProvider } from '../bedrock';

describe('Provider Factory', () => {
  describe('createProvider', () => {
    it('should create OllamaProvider for ollama config', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: {
          model: 'qwen3-coder:30b',
          host: 'http://localhost:11434'
        }
      };

      const provider = createProvider(config);

      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.name).toBe('ollama');
    });

    it('should create BedrockProvider for bedrock config', () => {
      const config: ProviderConfig = {
        provider: 'bedrock',
        bedrock: {
          model: 'anthropic.claude-3-sonnet-20240229-v1:0',
          region: 'us-east-1'
        }
      };

      const provider = createProvider(config);

      expect(provider).toBeInstanceOf(BedrockProvider);
      expect(provider.name).toBe('bedrock');
    });

    it('should return LLMProvider interface type', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: {
          model: 'qwen3-coder:30b'
        }
      };

      const provider = createProvider(config);

      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe('function');
      expect(typeof provider.streamChat).toBe('function');
      expect(provider.name).toBeDefined();
    });

    it('should throw error for unknown provider type', () => {
      const config: any = {
        provider: 'unknown',
        unknown: { model: 'test' }
      };

      expect(() => createProvider(config)).toThrow();
    });

    it('should include valid providers in error message', () => {
      const config: any = {
        provider: 'unknown',
        unknown: { model: 'test' }
      };

      expect(() => createProvider(config)).toThrow(/ollama/);
      expect(() => createProvider(config)).toThrow(/bedrock/);
    });
  });

  describe('extractModelFromConfig', () => {
    it('should return model from Ollama config', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: {
          model: 'qwen3-coder:30b'
        }
      };

      const model = extractModelFromConfig(config);

      expect(model).toBe('qwen3-coder:30b');
    });

    it('should return model from Bedrock config', () => {
      const config: ProviderConfig = {
        provider: 'bedrock',
        bedrock: {
          model: 'anthropic.claude-3-sonnet-20240229-v1:0'
        }
      };

      const model = extractModelFromConfig(config);

      expect(model).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    });

    it('should return undefined for missing model in config', () => {
      const config: any = {
        provider: 'ollama',
        ollama: {}
      };

      const model = extractModelFromConfig(config);

      expect(model).toBeUndefined();
    });

    it('should return undefined for unknown provider type', () => {
      const config: any = {
        provider: 'unknown',
        unknown: { model: 'test' }
      };

      const model = extractModelFromConfig(config);

      expect(model).toBeUndefined();
    });
  });
});
