## Context

The agent currently supports two LLM providers through a unified `LLMProvider` interface:

- **OllamaProvider**: Local model server using the Ollama SDK
- **BedrockProvider**: AWS Bedrock using AWS SDK with native fetch for API calls

Each provider implements:

- `chat()` for non-streaming completions
- `streamChat()` for streaming responses
- Type translation between provider-agnostic types (`ChatMessage`, `ChatTool`) and provider-specific formats
- Error translation to standard `ProviderError` types

Provider configuration uses a discriminated union pattern with a factory function (`createProvider`) that instantiates providers based on the `type` field. The agent supports runtime provider switching while preserving conversation context.

**OpenRouter** provides unified access to 300+ AI models through a single OpenAI-compatible API endpoint. It's particularly valuable for accessing affordable models with modern tool calling support (e.g., DeepSeek R1, various OpenAI models) at lower cost than direct provider access.

## Goals / Non-Goals

**Goals:**

- Add OpenRouter as a fully-featured provider supporting chat, streaming, and tool calling
- Follow the existing provider implementation pattern (interface, types, factory)
- Minimize dependencies by using native `fetch` (following Bedrock's approach)
- Support OpenRouter-specific features (API key auth, optional site tracking headers)
- Maintain backward compatibility with existing providers and configuration

**Non-Goals:**

- OpenRouter advanced features (provider routing preferences, fallback configuration) - these can be added later
- Response caching or cost tracking - out of scope for initial implementation
- OpenRouter-specific model discovery or listing - users configure models manually like other providers
- Supporting legacy OpenRouter API versions - only support current `/api/v1/chat/completions`

## Decisions

### Decision 1: Use Native Fetch Instead of SDK

**Choice:** Implement using native `fetch` API, not the official `@openrouter/sdk` package.

**Rationale:**

- **Consistency**: Bedrock provider already uses native fetch; maintains implementation consistency
- **Bundle size**: Avoids adding another dependency (agent currently has only 2 direct dependencies: `ollama`, `@aws-sdk/client-bedrock-runtime`)
- **Simplicity**: OpenRouter's API is OpenAI-compatible and straightforward to call directly
- **Control**: Direct fetch calls give us precise control over headers, error handling, and streaming

**Alternatives Considered:**

- Use `@openrouter/sdk`: More convenient but adds dependency and abstracts away control we need for error handling
- Use OpenAI SDK with base URL override: Works but requires OpenAI SDK dependency for a single provider

**Trade-off**: Slightly more code to write (JSON parsing, SSE parsing) but maintains lean dependency profile.

---

### Decision 2: OpenAI-Compatible Request/Response Format

**Choice:** Map provider-agnostic types directly to OpenAI format without custom translation logic.

**Rationale:**

- **API Compatibility**: OpenRouter uses OpenAI's request/response schema exactly
- **Tool Calling**: OpenRouter supports OpenAI's tool calling format including `tools` array and `tool_calls` response
- **Proven Pattern**: This is the format most developers are familiar with
- **Future-proof**: OpenAI format is industry standard, unlikely to break

**Implementation Details:**

```typescript
// Request format (OpenAI-compatible)
{
  model: string,
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool",
    content: string,
    tool_calls?: Array<{
      id: string,
      type: "function",
      function: { name: string, arguments: string }
    }>,
    tool_call_id?: string // for tool role messages
  }>,
  tools?: Array<{
    type: "function",
    function: {
      name: string,
      description: string,
      parameters: object // JSON Schema
    }
  }>,
  stream?: boolean
}

// Response format
{
  id: string,
  choices: Array<{
    message: {
      role: "assistant",
      content: string,
      tool_calls?: Array<{...}>
    },
    finish_reason: "stop" | "tool_calls" | "length"
  }>
}
```

**Alternatives Considered:**

- Custom OpenRouter extensions: Not needed for initial implementation; OpenAI format covers our needs

---

### Decision 3: Server-Sent Events (SSE) Parsing for Streaming

**Choice:** Implement custom SSE parser for streaming responses.

**Rationale:**

- **Native Format**: OpenRouter streams use SSE (`data: {...}\n\n` format)
- **Control**: Custom parser allows precise handling of `[DONE]` marker and partial chunks
- **No Dependencies**: Node.js/browser `fetch` supports streaming responses natively
- **Error Handling**: We can detect and handle streaming errors mid-stream

**Implementation Pattern:**

```typescript
async *streamChat(request: ChatRequest): AsyncIterable<ChatChunk> {
  const response = await fetch(url, { ... });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        const chunk = JSON.parse(data);
        // Process chunk...
      }
    }
  }
}
```

**Alternatives Considered:**

- Use SSE library: Adds dependency, overkill for simple parsing
- Accumulate full response: Defeats purpose of streaming

---

### Decision 4: API Key via Configuration, Optional Headers

**Choice:** Require API key in provider config, support optional HTTP headers for site tracking.

**Rationale:**

- **Security**: API key stored in `.propio/providers.json` (already gitignored)
- **Consistency**: Matches how Bedrock credentials work (via AWS SDK config)
- **Flexibility**: Optional headers allow users to get ranked on OpenRouter leaderboard if desired
- **Environment Override**: Support `OPENROUTER_API_KEY` env var as fallback

**Configuration Structure:**

```typescript
interface OpenRouterProviderConfig extends BaseProviderConfig {
  type: "openrouter";
  apiKey?: string; // If not provided, reads from OPENROUTER_API_KEY env var
  httpReferer?: string; // Optional: site URL for rankings
  xTitle?: string; // Optional: site name for rankings
}
```

**Alternatives Considered:**

- Require env var only: Less flexible, doesn't match multi-provider config pattern
- No optional headers: Simpler but removes useful OpenRouter feature

**Trade-off**: Users must manage API keys, but this matches existing provider patterns.

---

### Decision 5: Error Mapping Strategy

**Choice:** Map HTTP status codes and error messages to standard `ProviderError` types.

**Rationale:**

- **Consistency**: Matches Ollama and Bedrock error handling patterns
- **Typed Errors**: `ProviderAuthenticationError`, `ProviderRateLimitError`, `ProviderModelNotFoundError`
- **Debugging**: Preserve original error in `originalError` field

**Error Mapping:**

- `401 Unauthorized` → `ProviderAuthenticationError` (invalid API key)
- `429 Too Many Requests` → `ProviderRateLimitError` (with retry-after if available)
- `404 Not Found` (with model in path) → `ProviderModelNotFoundError`
- `402 Payment Required` → `ProviderError` (insufficient credits)
- `5xx Server Errors` → `ProviderError` (OpenRouter service issues)

**Implementation:**

```typescript
private translateError(error: any, response?: Response): ProviderError {
  if (response?.status === 401) {
    return new ProviderAuthenticationError('Invalid OpenRouter API key');
  }
  if (response?.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    return new ProviderRateLimitError(
      'OpenRouter rate limit exceeded',
      retryAfter ? parseInt(retryAfter) : undefined
    );
  }
  // ... more mappings
}
```

---

### Decision 6: Factory Integration Pattern

**Choice:** Add `openrouter` case to existing `createProvider` factory function.

**Rationale:**

- **Minimal Changes**: Only adds one case to switch statement
- **Consistency**: Follows established pattern for Ollama and Bedrock
- **Type Safety**: TypeScript discriminated union ensures correct config type

**Implementation:**

```typescript
// In src/providers/factory.ts
case 'openrouter':
  return new OpenRouterProvider({
    model: model,
    apiKey: (config as OpenRouterProviderConfig).apiKey,
    httpReferer: (config as OpenRouterProviderConfig).httpReferer,
    xTitle: (config as OpenRouterProviderConfig).xTitle
  });
```

## Risks / Trade-offs

### Risk 1: API Key Exposure

**Risk:** API keys in config files could be accidentally committed to version control.

**Mitigation:**

- `.propio/` directory is already in `.gitignore`
- Support `OPENROUTER_API_KEY` environment variable as alternative
- Document security best practices in README
- Consider adding a warning if API key appears to be hardcoded

---

### Risk 2: Rate Limiting

**Risk:** OpenRouter has rate limits that vary by account tier; hitting limits could cause request failures.

**Mitigation:**

- Properly translate 429 errors to `ProviderRateLimitError` with retry-after info
- Include retry-after seconds in error object for intelligent retry logic
- Document rate limits in README
- Future: Could add automatic retry with exponential backoff (not in initial scope)

---

### Risk 3: Streaming Parsing Errors

**Risk:** SSE parsing could fail on malformed chunks or network issues mid-stream.

**Mitigation:**

- Wrap JSON parsing in try-catch, skip malformed lines
- Handle partial chunks with buffer accumulation
- Detect connection drops and throw appropriate errors
- Test with various models/providers that OpenRouter routes to

---

### Risk 4: Model Identifier Differences

**Risk:** OpenRouter uses `provider/model` format (e.g., `openai/gpt-4o`), different from other providers.

**Mitigation:**

- Document expected model format in config and README
- This is just a string - no special handling needed, pass through as-is
- Users are responsible for valid model IDs (consistent with Ollama/Bedrock)

**Trade-off:** No client-side validation of model IDs, but this matches existing provider behavior.

---

### Risk 5: Network Failures

**Risk:** fetch can fail with network errors, DNS issues, timeouts.

**Mitigation:**

- Wrap fetch calls in try-catch
- Translate ECONNREFUSED, ETIMEDOUT to `ProviderAuthenticationError` or `ProviderError`
- Include helpful error messages (e.g., "Failed to connect to OpenRouter API")
- Consider adding request timeout (future enhancement)

---

### Risk 6: Tool Calling Format Variations

**Risk:** OpenRouter routes to different providers; tool calling format might vary slightly.

**Mitigation:**

- OpenRouter normalizes to OpenAI format across all models
- Test with multiple model providers (OpenAI, Anthropic, etc.) to verify consistency
- Follow OpenAI's tool calling spec exactly (id, type, function.name, function.arguments)

**Trade-off:** If OpenRouter changes normalization behavior, we may need updates. Low risk given OpenRouter's stability.

## Migration Plan

**This is an additive change with no breaking changes or migrations required.**

### Deployment Steps

1. **Add OpenRouterProvider implementation** (`src/providers/openrouter.ts`)
   - Implement `LLMProvider` interface
   - Add type translation methods
   - Add error handling

2. **Update configuration types** (`src/providers/config.ts`)
   - Add `OpenRouterProviderConfig` interface
   - Update `ProviderConfig` union type

3. **Update factory** (`src/providers/factory.ts`)
   - Add `openrouter` case to `createProvider` switch
   - Update error message to include openrouter in valid providers list

4. **Add configuration example**
   - Update README with OpenRouter configuration example
   - Add example to `.propio/providers.json` documentation

5. **Testing**
   - Unit tests for OpenRouterProvider (chat, streamChat, error handling)
   - Integration test with real OpenRouter API (use cheap model)
   - Test tool calling with a model that supports it

### Rollback Strategy

If issues arise:

- Remove `openrouter` case from factory switch statement
- Existing Ollama/Bedrock providers continue working unchanged
- No data migration needed (configuration is per-deployment)

### Verification

After deployment, verify:

- ✅ Can create OpenRouter provider via factory
- ✅ Non-streaming chat works with a test prompt
- ✅ Streaming chat produces incremental chunks
- ✅ Tool calling request/response cycle completes
- ✅ Invalid API key returns `ProviderAuthenticationError`
- ✅ Rate limiting returns `ProviderRateLimitError`
- ✅ Agent can switch between OpenRouter and other providers at runtime

## Open Questions

None at this time. The OpenRouter API is well-documented and OpenAI-compatible, minimizing unknowns.
