# Add Anthropic (Claude API) Provider

## Context
Added Claude API (Anthropic direct API) as a provider in propio-agent. Previously supported providers were: ollama, bedrock, openrouter, gemini, xai, cloudflare. This implements a native Anthropic SDK integration (matching how Bedrock uses the AWS SDK), rather than the simpler OpenAI-compatibility shim, to get proper support for extended thinking/reasoning and typed errors.

## Implementation Approach

Used the `@anthropic-ai/sdk` package and implemented `LLMProvider` directly (same pattern as `BedrockProvider`). Provider type is `"anthropic"`.

## Files Changed

### 1. `package.json`
Added dependency:
```json
"@anthropic-ai/sdk": "^0.54.0"
```

### 2. `src/providers/config.ts`
Added new interface and extended the union type:
```typescript
export interface AnthropicProviderConfig extends BaseProviderConfig {
  type: "anthropic";
  apiKey?: string;
}
```
Added `AnthropicProviderConfig` to the `ProviderConfig` union.

### 3. `src/providers/anthropic.ts` (new file)
Implemented `AnthropicProvider implements LLMProvider`:

- **Constructor**: Resolves `apiKey` from `options.apiKey ?? process.env.ANTHROPIC_API_KEY`. Throws `ProviderAuthenticationError` if missing.
- **Message translation** (`chatMessageToAnthropicMessage`): Maps `ChatMessage` → Anthropic `MessageParam`. Handles roles: `user`, `assistant`, `system` (extracted separately), `tool` → user message with `tool_result` blocks. Maps `toolCalls` → `tool_use` content blocks. Handles `images` as `image` content blocks (base64). Handles batched `toolResults`.
- **Tool translation** (`chatToolToAnthropicTool`): Maps `ChatTool` → Anthropic `Tool` (`input_schema`).
- **`streamChat()`**: Uses `anthropic.messages.stream({ model, messages, system, tools, max_tokens, thinking: requestReasoning ? { type: "enabled", budget_tokens } : undefined })`. Maps stream events:
  - `text_delta` → text content
  - `thinking_delta` → `{ type: "thinking_delta", delta }`
  - `tool_use` block → accumulate → `{ type: "tool_calls", toolCalls: [...] }`
  - `message_stop` with `stop_reason` → `{ type: "terminal", stopReason }`
- **Error translation**: Maps Anthropic SDK error types to `ProviderAuthenticationError`, `ProviderRateLimitError`, `ProviderContextLengthError`, `ProviderModelNotFoundError`, `ProviderError`.
- **Retry**: Uses `withRetry` from `./withRetry.ts` (same as Bedrock).

### 4. `src/providers/factory.ts`
Added import and case:
```typescript
import { AnthropicProvider } from "./anthropic.js";
// ...
case "anthropic": {
  const anthropicConfig = config as AnthropicProviderConfig;
  const modelConfig = resolveModelConfig();
  return new AnthropicProvider({
    model,
    contextWindowTokens: modelConfig.contextWindowTokens,
    apiKey: anthropicConfig.apiKey,
    retryConfig,
    onDiagnosticEvent,
  });
}
```
Updated the default error message to include `anthropic`.

## providers.json example
```json
{
  "name": "anthropic",
  "type": "anthropic",
  "models": [
    { "name": "Claude Sonnet 4.6", "key": "claude-sonnet-4-6", "contextWindowTokens": 200000 },
    { "name": "Claude Opus 4.7", "key": "claude-opus-4-7", "contextWindowTokens": 200000 }
  ],
  "defaultModel": "claude-sonnet-4-6",
  "apiKey": "sk-ant-..."
}
```

## Verification
- ✅ `npm install` — SDK installed successfully
- ✅ `npm run build` — Zero TypeScript errors
- ✅ `npm test` — All 1670 tests pass
- To test with real API:
  1. Add anthropic entry to `~/.propio/providers.json` with real API key
  2. Run `propio` and verify Claude responses stream correctly with text and tool calls

## Key Implementation Details

### Stream Event Handling
The Anthropic SDK's `MessageStream` returns `RawMessageStreamEvent` types, which include:
- `RawContentBlockStartEvent` - marks tool_use blocks
- `RawContentBlockDeltaEvent` - delta events with typed payload (TextDelta, ThinkingDelta, InputJSONDelta)
- `RawContentBlockStopEvent` - marks end of blocks
- `RawMessageStopEvent` - includes stop_reason

### Message Format
Messages are translated to Anthropic format with:
- Text content as `{ type: "text", text }` blocks
- Tool calls as `{ type: "tool_use", id, name, input }` blocks  
- Images as `{ type: "image", source: { type: "base64", media_type, data } }` blocks
- Tool results as `{ type: "tool_result", tool_use_id, content }` blocks
- Tool messages are converted to user role with tool_result content blocks

### Extended Thinking
When `requestReasoning` is true, passes `thinking: { type: "enabled", budget_tokens: 10000 }` to enable extended thinking/reasoning capabilities.
