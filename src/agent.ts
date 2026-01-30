import { Ollama } from 'ollama';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class Agent {
  private ollama: Ollama;
  private model: string;
  private conversationHistory: Message[];
  private systemPrompt: string;

  constructor(options: {
    model?: string;
    host?: string;
    systemPrompt?: string;
  } = {}) {
    this.model = options.model || 'qwen3-coder:30b';
    this.ollama = new Ollama({
      host: options.host || process.env.OLLAMA_HOST || 'http://localhost:11434'
    });
    this.systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    this.conversationHistory = [];
  }

  async chat(userMessage: string): Promise<string> {
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory
    ];

    try {
      const response = await this.ollama.chat({
        model: this.model,
        messages: messages,
        stream: false
      });

      const assistantMessage = response.message.content;

      this.conversationHistory.push({
        role: 'assistant',
        content: assistantMessage
      });

      return assistantMessage;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
    }
  }

  async streamChat(userMessage: string, onToken: (token: string) => void): Promise<string> {
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      ...this.conversationHistory
    ];

    try {
      const response = await this.ollama.chat({
        model: this.model,
        messages: messages,
        stream: true
      });

      let fullResponse = '';

      for await (const part of response) {
        const token = part.message.content;
        fullResponse += token;
        onToken(token);
      }

      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      });

      return fullResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get response from Ollama: ${errorMessage}`);
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
}
