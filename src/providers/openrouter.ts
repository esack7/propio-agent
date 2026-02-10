import { LLMProvider } from './interface';
import {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatTool,
  ChatToolCall,
  ProviderError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderModelNotFoundError
} from './types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** OpenAI-compatible message format for API request */
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** OpenAI-compatible tool format */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

/**
 * OpenRouter implementation of LLMProvider using native fetch and OpenAI-compatible API.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  private readonly model: string;
  private readonly apiKey: string;
  private readonly httpReferer?: string;
  private readonly xTitle?: string;

  constructor(options: {
    model: string;
    apiKey?: string;
    httpReferer?: string;
    xTitle?: string;
  }) {
    const apiKey =
      options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey || apiKey.trim() === '') {
      throw new ProviderAuthenticationError('OpenRouter API key is required. Set OPENROUTER_API_KEY or pass apiKey in options.');
    }
    this.model = options.model;
    this.apiKey = apiKey;
    this.httpReferer = options.httpReferer;
    this.xTitle = options.xTitle;
  }

  private chatMessageToOpenAIMessage(msg: ChatMessage): OpenAIMessage {
    const role = msg.role as OpenAIMessage['role'];
    const out: OpenAIMessage = { role, content: msg.content ?? '' };
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map(tc => ({
        id: tc.id ?? `call_${tc.function.name}_${Date.now()}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {})
        }
      }));
    }
    if (msg.role === 'tool' && msg.toolCallId) {
      out.tool_call_id = msg.toolCallId;
    }
    return out;
  }

  private openAIMessageToChatMessage(msg: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }): ChatMessage {
    const content = msg.content ?? '';
    const toolCalls: ChatToolCall[] = [];
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function;
        let args: Record<string, unknown> = {};
        if (fn?.arguments) {
          try {
            args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
          } catch {
            args = { raw: fn.arguments };
          }
        }
        toolCalls.push({
          id: tc.id,
          function: {
            name: fn?.name ?? '',
            arguments: args as Record<string, any>
          }
        });
      }
    }
    const chatMsg: ChatMessage = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      chatMsg.toolCalls = toolCalls;
    }
    return chatMsg;
  }

  private chatToolToOpenAITool(tool: ChatTool): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: (tool.function.parameters ?? { type: 'object', properties: {} }) as object
      }
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const messages = request.messages.map(m => this.chatMessageToOpenAIMessage(m));
      const body: Record<string, unknown> = {
        model: request.model || this.model,
        messages,
        stream: false
      };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map(t => this.chatToolToOpenAITool(t));
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      };
      if (this.httpReferer) headers['HTTP-Referer'] = this.httpReferer;
      if (this.xTitle) headers['X-Title'] = this.xTitle;

      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw this.translateError(new Error(`HTTP ${response.status}`), response);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            role?: string;
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string;
        }>;
      };
      const choice = data.choices?.[0];
      if (!choice?.message) {
        throw this.translateError(new Error('No choices[0].message in response'));
      }
      const message = this.openAIMessageToChatMessage(choice.message);
      const finishReason = choice.finish_reason ?? 'stop';
      const stopReason: ChatResponse['stopReason'] =
        finishReason === 'tool_calls' ? 'tool_use'
        : finishReason === 'length' ? 'max_tokens'
        : 'end_turn';
      return { message, stopReason };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
    try {
      const messages = request.messages.map(m => this.chatMessageToOpenAIMessage(m));
      const body: Record<string, unknown> = {
        model: request.model || this.model,
        messages,
        stream: true
      };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map(t => this.chatToolToOpenAITool(t));
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      };
      if (this.httpReferer) headers['HTTP-Referer'] = this.httpReferer;
      if (this.xTitle) headers['X-Title'] = this.xTitle;

      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw this.translateError(new Error(`HTTP ${response.status}`), response);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw this.translateError(new Error('No response body'));
      }
      const decoder = new TextDecoder();
      let buffer = '';

      const toolCallsByIndex = new Map<
        number,
        { id?: string; name: string; argsString: string }
      >();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;

          let chunk: {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
              finish_reason?: string;
            }>;
          };
          try {
            chunk = JSON.parse(data) as typeof chunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice?.delta) continue;

          const delta = choice.delta;
          if (delta.content != null && delta.content !== '') {
            yield { delta: delta.content };
          }

          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let acc = toolCallsByIndex.get(idx);
              if (!acc) {
                acc = { name: '', argsString: '' };
                toolCallsByIndex.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments != null) acc.argsString += tc.function.arguments;
            }
          }

          if (choice.finish_reason === 'tool_calls') {
            const toolCalls: ChatToolCall[] = [];
            const indices = [...toolCallsByIndex.keys()].sort((a, b) => a - b);
            for (const i of indices) {
              const acc = toolCallsByIndex.get(i)!;
              let args: Record<string, any> = {};
              if (acc.argsString) {
                try {
                  args = JSON.parse(acc.argsString);
                } catch {
                  args = { raw: acc.argsString };
                }
              }
              toolCalls.push({
                id: acc.id,
                function: { name: acc.name || '', arguments: args }
              });
            }
            if (toolCalls.length > 0) {
              yield { delta: '', toolCalls };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.translateError(error);
    }
  }

  private translateError(error: unknown, response?: Response): ProviderError {
    const originalError = error instanceof Error ? error : new Error(String(error));
    if (response) {
      if (response.status === 401) {
        return new ProviderAuthenticationError('Invalid OpenRouter API key', originalError);
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        return new ProviderRateLimitError(
          'OpenRouter rate limit exceeded',
          Number.isNaN(retryAfterSeconds) ? undefined : retryAfterSeconds,
          originalError
        );
      }
      if (response.status === 404) {
        return new ProviderModelNotFoundError(
          this.model,
          `Model not found: ${this.model}`,
          originalError
        );
      }
      if (response.status === 402) {
        return new ProviderError('Insufficient OpenRouter credits', originalError);
      }
      if (response.status >= 500 && response.status < 600) {
        return new ProviderError('OpenRouter service error', originalError);
      }
    }
    const msg = originalError.message;
    if (msg && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed'))) {
      return new ProviderError('Failed to connect to OpenRouter API', originalError);
    }
    return new ProviderError(originalError.message || 'OpenRouter request failed', originalError);
  }
}
