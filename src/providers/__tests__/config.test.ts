import { ProviderConfig } from '../config';

describe('ProviderConfig', () => {
  describe('Ollama configuration', () => {
    it('should define ollama provider configuration', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: {
          model: 'qwen3-coder:30b',
          host: 'http://localhost:11434'
        }
      };
      expect(config.provider).toBe('ollama');
      expect(config.ollama?.model).toBe('qwen3-coder:30b');
      expect(config.ollama?.host).toBe('http://localhost:11434');
    });

    it('should allow ollama configuration without host (uses default)', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: {
          model: 'neural-chat'
        }
      };
      expect(config.provider).toBe('ollama');
      expect(config.ollama?.model).toBe('neural-chat');
      expect(config.ollama?.host).toBeUndefined();
    });
  });

  describe('Bedrock configuration', () => {
    it('should define bedrock provider configuration', () => {
      const config: ProviderConfig = {
        provider: 'bedrock',
        bedrock: {
          model: 'anthropic.claude-3-sonnet-20240229-v1:0',
          region: 'us-west-2'
        }
      };
      expect(config.provider).toBe('bedrock');
      expect(config.bedrock?.model).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
      expect(config.bedrock?.region).toBe('us-west-2');
    });

    it('should allow bedrock configuration without region (uses default)', () => {
      const config: ProviderConfig = {
        provider: 'bedrock',
        bedrock: {
          model: 'anthropic.claude-3-sonnet-20240229-v1:0'
        }
      };
      expect(config.provider).toBe('bedrock');
      expect(config.bedrock?.model).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
      expect(config.bedrock?.region).toBeUndefined();
    });
  });

  describe('Configuration validation', () => {
    it('should support ollama provider type', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        ollama: { model: 'test' }
      };
      expect(config.provider).toBe('ollama');
    });

    it('should support bedrock provider type', () => {
      const config: ProviderConfig = {
        provider: 'bedrock',
        bedrock: { model: 'test' }
      };
      expect(config.provider).toBe('bedrock');
    });
  });
});
