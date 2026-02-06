## ADDED Requirements

### Requirement: Ollama client initialization

The system SHALL provide an OllamaProvider class that implements the LLMProvider interface using the `ollama` npm package (version 0.6.3 or higher).

#### Scenario: Provider initializes with host configuration
- **WHEN** OllamaProvider is instantiated with a host URL
- **THEN** it SHALL create an Ollama client instance with the specified host

#### Scenario: Provider uses default localhost
- **WHEN** OllamaProvider is instantiated without a host URL
- **THEN** it SHALL default to `http://localhost:11434` as the Ollama host

#### Scenario: Provider accepts environment variable
- **WHEN** OllamaProvider is instantiated and OLLAMA_HOST environment variable is set
- **THEN** it SHALL use the environment variable value as the host

#### Scenario: Provider identifier
- **WHEN** OllamaProvider name property is accessed
- **THEN** it SHALL return "ollama"

### Requirement: Message type translation

The system SHALL translate between ChatMessage (provider-agnostic) and Ollama's Message type.

#### Scenario: Translate ChatMessage to Ollama Message
- **WHEN** a ChatMessage with role and content is provided
- **THEN** the provider SHALL map it to Ollama's Message format with matching `role` and `content` fields

#### Scenario: Translate tool calls to Ollama format
- **WHEN** a ChatMessage includes toolCalls
- **THEN** the provider SHALL map them to Ollama's `tool_calls` field with ToolCall objects

#### Scenario: Translate images to Ollama format
- **WHEN** a ChatMessage includes images
- **THEN** the provider SHALL map them to Ollama's `images` field as Uint8Array[] or string[]

#### Scenario: Translate Ollama Message to ChatMessage
- **WHEN** Ollama returns a Message object
- **THEN** the provider SHALL map it to ChatMessage format preserving role, content, and tool_calls

### Requirement: Tool definition translation

The system SHALL translate between ChatTool (provider-agnostic) and Ollama's Tool type.

#### Scenario: Translate ChatTool to Ollama Tool
- **WHEN** a ChatTool is provided in a request
- **THEN** the provider SHALL map it to Ollama's Tool format with `type: 'function'` and function details

#### Scenario: Preserve tool parameters
- **WHEN** a ChatTool includes JSON Schema parameters
- **THEN** the provider SHALL map them to Ollama's parameters format with type, properties, and required fields

### Requirement: Non-streaming chat implementation

The system SHALL implement the chat() method using Ollama's non-streaming chat API.

#### Scenario: Successful non-streaming request
- **WHEN** chat() is called with a ChatRequest
- **THEN** it SHALL call `ollama.chat()` with `stream: false` and return a ChatResponse

#### Scenario: Model selection
- **WHEN** chat() is called with a specific model in ChatRequest
- **THEN** it SHALL pass the model name to Ollama's chat method

#### Scenario: Tools passed to Ollama
- **WHEN** chat() is called with tools in ChatRequest
- **THEN** it SHALL translate and pass tools to Ollama's chat method

#### Scenario: Response includes stop reason
- **WHEN** Ollama completes a chat request
- **THEN** the provider SHALL map Ollama's completion status to a stop reason ('end_turn', 'tool_use', 'max_tokens', or 'stop_sequence')

### Requirement: Streaming chat implementation

The system SHALL implement the streamChat() method using Ollama's streaming chat API.

#### Scenario: Successful streaming request
- **WHEN** streamChat() is called with a ChatRequest
- **THEN** it SHALL call `ollama.chat()` with `stream: true` and yield ChatChunk objects

#### Scenario: Stream yields content deltas
- **WHEN** Ollama streams response chunks
- **THEN** the provider SHALL yield ChatChunk objects with delta field containing incremental content

#### Scenario: Stream completes with tool calls
- **WHEN** Ollama completes streaming with tool calls
- **THEN** the provider SHALL include toolCalls in the final ChatChunk

#### Scenario: Stream error handling
- **WHEN** Ollama streaming encounters an error
- **THEN** the provider SHALL throw a ProviderError with details

### Requirement: Error handling

The system SHALL handle Ollama-specific errors and translate them to standard ProviderError types.

#### Scenario: Connection error handling
- **WHEN** Ollama client cannot connect to the host
- **THEN** the provider SHALL throw ProviderAuthenticationError with connection details

#### Scenario: Model not found handling
- **WHEN** Ollama returns a model not found error
- **THEN** the provider SHALL throw ProviderModelNotFoundError with the requested model name

#### Scenario: Generic error handling
- **WHEN** Ollama returns any other error
- **THEN** the provider SHALL throw ProviderError with the error message and original error

### Requirement: Backward compatibility

The system SHALL maintain compatibility with existing Ollama configurations in the agent.

#### Scenario: Support existing model names
- **WHEN** the agent uses an existing Ollama model name (e.g., 'qwen3-coder:30b')
- **THEN** the provider SHALL pass it through without modification

#### Scenario: Support existing host configurations
- **WHEN** the agent specifies a custom Ollama host
- **THEN** the provider SHALL use that host exactly as before

#### Scenario: Support existing message formats
- **WHEN** messages are provided in the current agent format
- **THEN** the provider SHALL handle them identically to the current implementation
