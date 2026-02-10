## 1. Phase 1: Create Provider Abstraction

- [x] 1.1 Create `src/providers/` directory structure
- [x] 1.2 Define provider-agnostic types in `src/providers/types.ts` (ChatMessage, ChatTool, ChatToolCall, ChatRequest, ChatResponse, ChatChunk)
- [x] 1.3 Define error types in `src/providers/types.ts` (ProviderError, ProviderAuthenticationError, ProviderRateLimitError, ProviderModelNotFoundError)
- [x] 1.4 Define LLMProvider interface in `src/providers/interface.ts` with chat(), streamChat(), and name property
- [x] 1.5 Define ProviderConfig type for configuration
- [x] 1.6 Add unit tests for type definitions

## 2. Phase 2: Extract Ollama Provider

- [x] 2.1 Create `src/providers/ollama.ts` with OllamaProvider class implementing LLMProvider interface
- [x] 2.2 Implement OllamaProvider constructor with host configuration
- [x] 2.3 Implement message type translation: ChatMessage <-> Ollama Message
- [x] 2.4 Implement tool type translation: ChatTool <-> Ollama Tool
- [x] 2.5 Implement tool call translation: ChatToolCall <-> Ollama ToolCall
- [x] 2.6 Implement OllamaProvider.chat() method (non-streaming)
- [x] 2.7 Implement OllamaProvider.streamChat() method (streaming with AsyncIterable)
- [x] 2.8 Implement error handling and translation to ProviderError types
- [x] 2.9 Add unit tests for OllamaProvider type translations
- [x] 2.10 Add integration tests for OllamaProvider.chat() and streamChat()

## 3. Phase 3: Refactor Agent to Use Provider Interface

- [x] 3.1 Update Agent constructor to accept ProviderConfig parameter
- [x] 3.2 Update Agent constructor to maintain backward compatibility (map legacy options to ProviderConfig)
- [x] 3.3 Add provider factory function to create provider instances from config
- [x] 3.4 Replace private `ollama: Ollama` field with `provider: LLMProvider` field
- [x] 3.5 Remove direct Ollama imports from agent.ts
- [x] 3.6 Update sessionContext type from `Message[]` to `ChatMessage[]`
- [x] 3.7 Update tools initialization to use ChatTool type instead of Ollama Tool type
- [x] 3.8 Refactor Agent.chat() to build ChatRequest and call provider.chat()
- [x] 3.9 Refactor Agent.streamChat() to build ChatRequest and iterate over provider.streamChat()
- [x] 3.10 Update tool execution loop to handle ChatToolCall type
- [x] 3.11 Add switchProvider() method to Agent class
- [x] 3.12 Add error handling for provider errors in Agent
- [x] 3.13 Update existing unit tests to work with provider abstraction
- [x] 3.14 Add integration tests for backward compatibility

## 4. Phase 4: Add Bedrock Provider

- [x] 4.1 Add `@aws-sdk/client-bedrock-runtime` dependency to package.json
- [x] 4.2 Create `src/providers/bedrock.ts` with BedrockProvider class implementing LLMProvider interface
- [x] 4.3 Implement BedrockProvider constructor with region and credentials configuration
- [x] 4.4 Implement message type translation: ChatMessage <-> Bedrock Message (ConverseCommand format)
- [x] 4.5 Implement system message extraction for Bedrock's system parameter
- [x] 4.6 Implement tool type translation: ChatTool <-> Bedrock ToolSpecification
- [x] 4.7 Implement tool call translation: ChatToolCall <-> Bedrock toolUse blocks
- [x] 4.8 Implement tool result handling for Bedrock toolResult blocks
- [x] 4.9 Implement BedrockProvider.chat() using ConverseCommand
- [x] 4.10 Implement BedrockProvider.streamChat() using ConverseStreamCommand with event stream handling
- [x] 4.11 Implement stop reason mapping from Bedrock to provider-agnostic format
- [x] 4.12 Implement AWS SDK error handling and translation to ProviderError types
- [x] 4.13 Add unit tests for BedrockProvider type translations
- [x] 4.14 Add integration tests for BedrockProvider.chat() and streamChat() (requires AWS credentials)

## 5. Phase 5: Integration Testing & Documentation

- [x] 5.1 Test provider switching with Agent.switchProvider() between Ollama and Bedrock
- [x] 5.2 Test session context preservation when switching providers
- [x] 5.3 Test tool execution with OllamaProvider
- [x] 5.4 Test tool execution with BedrockProvider
- [x] 5.5 Test error handling across both providers
- [x] 5.6 Test streaming with both providers
- [x] 5.7 Update README with provider configuration examples
- [x] 5.8 Add inline documentation for provider interface and implementations
- [x] 5.9 Add example scripts demonstrating provider usage and switching
- [x] 5.10 Verify all existing agent functionality works with default Ollama provider
