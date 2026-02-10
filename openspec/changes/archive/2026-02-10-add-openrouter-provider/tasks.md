## 1. Configuration Types

- [x] 1.1 Add OpenRouterProviderConfig interface to src/providers/config.ts with type: 'openrouter', apiKey?, httpReferer?, and xTitle? fields
- [x] 1.2 Update ProviderConfig discriminated union type to include OpenRouterProviderConfig
- [x] 1.3 Verify TypeScript compilation with new config type

## 2. OpenRouter Provider Core Implementation

- [x] 2.1 Create src/providers/openrouter.ts file with OpenRouterProvider class skeleton
- [x] 2.2 Implement LLMProvider interface with readonly name = 'openrouter'
- [x] 2.3 Add constructor that accepts options: { model: string, apiKey?: string, httpReferer?: string, xTitle?: string }
- [x] 2.4 Implement API key resolution: use options.apiKey or fall back to process.env.OPENROUTER_API_KEY
- [x] 2.5 Throw ProviderAuthenticationError in constructor if no API key is available
- [x] 2.6 Store model, apiKey, httpReferer, and xTitle as private instance properties

## 3. Type Translation Methods

- [x] 3.1 Implement chatMessageToOpenAIMessage() method to convert ChatMessage to OpenAI format
- [x] 3.2 Handle tool_calls translation in chatMessageToOpenAIMessage() (convert ChatToolCall[] to OpenAI format with id, type, function)
- [x] 3.3 Handle tool role messages with tool_call_id field
- [x] 3.4 Implement openAIMessageToChatMessage() method to convert OpenAI response to ChatMessage
- [x] 3.5 Parse tool_calls from OpenAI response and convert to ChatToolCall[] format
- [x] 3.6 Implement chatToolToOpenAITool() method to convert ChatTool to OpenAI tools format

## 4. Non-Streaming Chat Implementation

- [x] 4.1 Implement chat() method with ChatRequest parameter
- [x] 4.2 Build request body with model, messages (translated), tools (if present), and stream: false
- [x] 4.3 Build headers object with Authorization: Bearer {apiKey}, Content-Type: application/json
- [x] 4.4 Add HTTP-Referer header if httpReferer is configured
- [x] 4.5 Add X-Title header if xTitle is configured
- [x] 4.6 Send POST request to https://openrouter.ai/api/v1/chat/completions using fetch
- [x] 4.7 Parse JSON response and extract choices[0].message
- [x] 4.8 Translate response message to ChatMessage using openAIMessageToChatMessage()
- [x] 4.9 Map finish_reason to stopReason ('stop' → 'end_turn', 'tool_calls' → 'tool_use', 'length' → 'max_tokens')
- [x] 4.10 Return ChatResponse with message and stopReason
- [x] 4.11 Wrap fetch in try-catch and call translateError() for all errors

## 5. Streaming Chat Implementation

- [x] 5.1 Implement streamChat() method as async generator returning AsyncIterable<ChatChunk>
- [x] 5.2 Build request body with stream: true
- [x] 5.3 Send POST request with same headers as non-streaming
- [x] 5.4 Get ReadableStream from response.body and create reader
- [x] 5.5 Create TextDecoder for decoding chunks
- [x] 5.6 Implement buffer accumulation for partial lines
- [x] 5.7 Parse SSE format: split on newlines, process lines starting with "data: "
- [x] 5.8 Handle [DONE] marker by returning from generator
- [x] 5.9 Parse JSON from data lines and extract choices[0].delta
- [x] 5.10 Yield ChatChunk with delta content when delta.content is present
- [x] 5.11 Accumulate tool_calls from delta.tool_calls across multiple chunks
- [x] 5.12 Yield final ChatChunk with toolCalls array when finish_reason is 'tool_calls'
- [x] 5.13 Handle JSON parse errors gracefully (skip malformed lines)
- [x] 5.14 Wrap in try-catch and call translateError() for streaming errors

## 6. Error Handling Implementation

- [x] 6.1 Implement translateError() private method that accepts error and optional Response
- [x] 6.2 Handle 401 status: throw ProviderAuthenticationError with "Invalid OpenRouter API key" message
- [x] 6.3 Handle 429 status: extract retry-after header, throw ProviderRateLimitError with retryAfterSeconds
- [x] 6.4 Handle 404 status: throw ProviderModelNotFoundError with model name
- [x] 6.5 Handle 402 status: throw ProviderError with "Insufficient OpenRouter credits" message
- [x] 6.6 Handle 5xx status: throw ProviderError with "OpenRouter service error" message
- [x] 6.7 Handle network errors (ECONNREFUSED, ETIMEDOUT): throw ProviderError with connection failure message
- [x] 6.8 Preserve original error in ProviderError.originalError field for all error types
- [x] 6.9 Handle generic errors with descriptive ProviderError message

## 7. Factory Integration

- [x] 7.1 Import OpenRouterProvider in src/providers/factory.ts
- [x] 7.2 Add 'openrouter' case to createProvider() switch statement
- [x] 7.3 Cast config to OpenRouterProviderConfig and extract apiKey, httpReferer, xTitle fields
- [x] 7.4 Instantiate OpenRouterProvider with model, apiKey, httpReferer, xTitle options
- [x] 7.5 Update error message in default case to include "openrouter" in valid providers list

## 8. Unit Tests

- [x] 8.1 Create src/providers/**tests**/openrouter.test.ts file
- [x] 8.2 Test constructor with API key from options
- [x] 8.3 Test constructor with API key from OPENROUTER_API_KEY env var
- [x] 8.4 Test constructor throws ProviderAuthenticationError when no API key is provided
- [x] 8.5 Test chat() method with mocked fetch for successful response
- [x] 8.6 Test chat() method translates messages correctly to OpenAI format
- [x] 8.7 Test chat() method handles tool calls in request and response
- [x] 8.8 Test chat() includes HTTP-Referer and X-Title headers when configured
- [x] 8.9 Test streamChat() method with mocked SSE response chunks
- [x] 8.10 Test streamChat() accumulates tool calls across chunks
- [x] 8.11 Test streamChat() handles [DONE] marker
- [x] 8.12 Test error translation for 401, 429, 404, 402, 5xx status codes
- [x] 8.13 Test error translation for network failures
- [x] 8.14 Test factory creates OpenRouterProvider correctly
- [x] 8.15 Verify all tests pass with npm test

## 9. Integration Tests

- [x] 9.1 Add integration test that creates OpenRouterProvider via factory
- [x] 9.2 Test non-streaming chat with real OpenRouter API (use cheap model like openai/gpt-3.5-turbo)
- [x] 9.3 Test streaming chat with real API and verify incremental chunks
- [x] 9.4 Test tool calling with a model that supports function calling
- [x] 9.5 Test invalid API key returns ProviderAuthenticationError
- [x] 9.6 Test runtime provider switching between OpenRouter and other providers

## 10. Configuration Example and Documentation

- [x] 10.1 Add OpenRouter example to README.md Provider Configuration section
- [x] 10.2 Document required fields: type, models, defaultModel, apiKey (or OPENROUTER_API_KEY env var)
- [x] 10.3 Document optional fields: httpReferer, xTitle for OpenRouter leaderboard tracking
- [x] 10.4 Add example .propio/providers.json configuration with OpenRouter provider
- [x] 10.5 Document model identifier format (provider/model, e.g., "openai/gpt-4o")
- [x] 10.6 Add note about API key management and .gitignore for .propio/ directory
- [x] 10.7 List example affordable models with tool calling support (e.g., openai/gpt-3.5-turbo, deepseek/deepseek-chat)

## 11. Verification and Cleanup

- [x] 11.1 Run TypeScript compiler and verify no errors
- [x] 11.2 Run all unit tests and verify 100% pass rate
- [x] 11.3 Run integration tests and verify OpenRouter provider works end-to-end
- [ ] 11.4 Verify linter passes with no new warnings
- [x] 11.5 Test agent can switch between Ollama, Bedrock, and OpenRouter at runtime
- [x] 11.6 Verify session context is preserved when switching providers
- [x] 11.7 Review code for any console.log statements or debug code and remove them
