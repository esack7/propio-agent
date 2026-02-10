## ADDED Requirements

### Requirement: Provider interface definition

The system SHALL define a TypeScript interface `LLMProvider` that establishes a standard contract for all LLM provider implementations.

#### Scenario: Interface defines chat method
- **WHEN** a provider implements the LLMProvider interface
- **THEN** it MUST provide a `chat(request: ChatRequest): Promise<ChatResponse>` method for non-streaming completions

#### Scenario: Interface defines stream chat method
- **WHEN** a provider implements the LLMProvider interface
- **THEN** it MUST provide a `streamChat(request: ChatRequest): AsyncIterable<ChatChunk>` method for streaming completions

#### Scenario: Interface identifies provider
- **WHEN** a provider implements the LLMProvider interface
- **THEN** it MUST expose a readonly `name: string` property that uniquely identifies the provider

### Requirement: Provider-agnostic message types

The system SHALL define provider-agnostic TypeScript types for messages that abstract away provider-specific formats.

#### Scenario: ChatMessage type structure
- **WHEN** a message is created
- **THEN** it SHALL include `role: 'user' | 'assistant' | 'system' | 'tool'` and `content: string` fields

#### Scenario: ChatMessage supports tool calls
- **WHEN** an assistant message includes tool invocations
- **THEN** the ChatMessage SHALL include an optional `toolCalls?: ChatToolCall[]` field

#### Scenario: ChatMessage supports images
- **WHEN** a user message includes images
- **THEN** the ChatMessage SHALL include an optional `images?: (Uint8Array | string)[]` field

### Requirement: Provider-agnostic tool types

The system SHALL define provider-agnostic TypeScript types for tools that work across all providers.

#### Scenario: ChatTool type structure
- **WHEN** a tool is defined
- **THEN** it SHALL include `type: 'function'` and a `function` object with `name`, `description`, and `parameters` fields

#### Scenario: ChatToolCall type structure
- **WHEN** a tool call is created
- **THEN** it SHALL include a `function` object with `name: string` and `arguments: Record<string, any>` fields

#### Scenario: Tool parameters use JSON Schema
- **WHEN** tool parameters are defined
- **THEN** they SHALL follow JSON Schema specification with `type`, `properties`, and optional `required` fields

### Requirement: Provider-agnostic request types

The system SHALL define a `ChatRequest` type that encapsulates all information needed for an LLM request.

#### Scenario: ChatRequest includes messages
- **WHEN** a chat request is created
- **THEN** it MUST include a `messages: ChatMessage[]` field

#### Scenario: ChatRequest includes model selection
- **WHEN** a chat request is created
- **THEN** it MUST include a `model: string` field identifying the model to use

#### Scenario: ChatRequest supports tools
- **WHEN** tools are available for the conversation
- **THEN** the ChatRequest SHALL include an optional `tools?: ChatTool[]` field

#### Scenario: ChatRequest supports streaming toggle
- **WHEN** a request specifies output format
- **THEN** the ChatRequest SHALL include an optional `stream?: boolean` field

### Requirement: Provider-agnostic response types

The system SHALL define response types that normalize outputs across providers.

#### Scenario: ChatResponse contains message
- **WHEN** a non-streaming chat completes
- **THEN** the ChatResponse SHALL include a `message: ChatMessage` field with the assistant's response

#### Scenario: ChatResponse includes stop reason
- **WHEN** a chat completes
- **THEN** the ChatResponse SHALL include a `stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'` field

#### Scenario: ChatChunk contains delta content
- **WHEN** a streaming chat produces output
- **THEN** each ChatChunk SHALL include a `delta: string` field with incremental content

#### Scenario: ChatChunk signals tool calls
- **WHEN** a streaming chat invokes tools
- **THEN** the final ChatChunk SHALL include optional `toolCalls?: ChatToolCall[]` field

### Requirement: Type translation contracts

The system SHALL require each provider implementation to translate between provider-agnostic types and provider-specific types.

#### Scenario: Provider translates incoming messages
- **WHEN** a provider receives a ChatRequest with ChatMessage array
- **THEN** it MUST convert ChatMessage objects to the provider's native message format before API calls

#### Scenario: Provider translates outgoing messages
- **WHEN** a provider receives responses from its API
- **THEN** it MUST convert the native response format to ChatMessage objects

#### Scenario: Provider translates tool definitions
- **WHEN** a provider receives ChatTool objects
- **THEN** it MUST convert them to the provider's native tool format before API calls

#### Scenario: Provider translates tool calls
- **WHEN** a provider's API returns tool invocations
- **THEN** it MUST convert them to ChatToolCall objects in the common format

### Requirement: Error handling contract

The system SHALL define standard error types that providers must use for consistent error handling.

#### Scenario: Provider throws ProviderError base class
- **WHEN** a provider encounters any error
- **THEN** it SHALL throw an error extending the `ProviderError` base class

#### Scenario: Authentication errors are typed
- **WHEN** a provider fails authentication
- **THEN** it SHALL throw a `ProviderAuthenticationError` with details

#### Scenario: Rate limit errors are typed
- **WHEN** a provider hits rate limits
- **THEN** it SHALL throw a `ProviderRateLimitError` with retry information

#### Scenario: Model not found errors are typed
- **WHEN** a requested model doesn't exist
- **THEN** it SHALL throw a `ProviderModelNotFoundError` with the invalid model name
