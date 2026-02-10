## ADDED Requirements

### Requirement: Provider configuration

The system SHALL allow the Agent class to be configured with an LLM provider at instantiation time.

#### Scenario: Agent accepts provider configuration

- **WHEN** Agent is instantiated with a provider configuration object
- **THEN** it SHALL initialize the appropriate LLMProvider implementation based on the configuration

#### Scenario: Default to Ollama provider

- **WHEN** Agent is instantiated without a provider configuration
- **THEN** it SHALL default to OllamaProvider with model 'qwen3-coder:30b' and localhost host for backward compatibility

#### Scenario: Configure Ollama provider

- **WHEN** Agent is instantiated with provider: 'ollama' configuration
- **THEN** it SHALL create an OllamaProvider with specified host and model settings

#### Scenario: Configure Bedrock provider

- **WHEN** Agent is instantiated with provider: 'bedrock' configuration
- **THEN** it SHALL create a BedrockProvider with specified region and model settings

#### Scenario: Provider-agnostic model setting

- **WHEN** Agent constructor receives a model parameter
- **THEN** it SHALL pass the model to the selected provider's configuration

### Requirement: Provider abstraction usage

The system SHALL refactor the Agent class to use the LLMProvider interface instead of direct Ollama client usage.

#### Scenario: Chat uses provider interface

- **WHEN** Agent.chat() is called with a user message
- **THEN** it SHALL build a ChatRequest and call provider.chat() instead of ollama.chat()

#### Scenario: Stream chat uses provider interface

- **WHEN** Agent.streamChat() is called with a user message
- **THEN** it SHALL build a ChatRequest and iterate over provider.streamChat() instead of ollama.chat()

#### Scenario: Remove direct Ollama imports

- **WHEN** Agent class is refactored
- **THEN** it SHALL NOT import from 'ollama' package directly

#### Scenario: Use provider-agnostic types

- **WHEN** Agent manages session context
- **THEN** it SHALL use ChatMessage type instead of Ollama-specific Message type

### Requirement: Session context compatibility

The system SHALL maintain session context functionality while using provider-agnostic message types.

#### Scenario: Store messages in provider-agnostic format

- **WHEN** Agent adds a message to session context
- **THEN** it SHALL store it as ChatMessage regardless of provider

#### Scenario: Session context includes user messages

- **WHEN** a user sends a message
- **THEN** Agent SHALL add a ChatMessage with role 'user' to sessionContext

#### Scenario: Session context includes assistant messages

- **WHEN** provider returns an assistant response
- **THEN** Agent SHALL add the response as ChatMessage with role 'assistant' to sessionContext

#### Scenario: Session context includes tool messages

- **WHEN** a tool is executed
- **THEN** Agent SHALL add a ChatMessage with role 'tool' and tool result content to sessionContext

#### Scenario: Session context preserves tool calls

- **WHEN** an assistant message includes tool calls
- **THEN** Agent SHALL preserve the toolCalls in the ChatMessage stored in sessionContext

### Requirement: Tool execution compatibility

The system SHALL maintain existing tool execution functionality with provider-agnostic tool types.

#### Scenario: Tools defined in provider-agnostic format

- **WHEN** Agent initializes tools
- **THEN** it SHALL define them as ChatTool objects instead of Ollama Tool objects

#### Scenario: Tools passed to provider

- **WHEN** Agent makes a chat request with tools
- **THEN** it SHALL include ChatTool array in the ChatRequest for provider translation

#### Scenario: Tool calls extracted from responses

- **WHEN** provider returns a response with tool calls
- **THEN** Agent SHALL extract ChatToolCall objects and execute corresponding tools

#### Scenario: Tool execution loop preserved

- **WHEN** provider response includes tool calls
- **THEN** Agent SHALL execute tools, add results to context, and continue chat loop as before

#### Scenario: Maximum iterations enforced

- **WHEN** Agent enters tool execution loop
- **THEN** it SHALL enforce maxIterations limit (10) to prevent infinite loops as before

### Requirement: Runtime provider switching

The system SHALL allow switching the LLM provider at runtime without losing session context.

#### Scenario: Switch provider method

- **WHEN** Agent.switchProvider() is called with a new provider configuration
- **THEN** it SHALL replace the current provider instance with a new one while preserving sessionContext

#### Scenario: Session context preserved across switch

- **WHEN** provider is switched
- **THEN** all messages in sessionContext SHALL remain intact using provider-agnostic ChatMessage format

#### Scenario: Provider switch validates configuration

- **WHEN** Agent.switchProvider() is called with invalid configuration
- **THEN** it SHALL throw an error without modifying the current provider

#### Scenario: Provider switch allows model change

- **WHEN** Agent.switchProvider() is called with same provider but different model
- **THEN** it SHALL update the model setting for subsequent requests

### Requirement: Backward compatibility

The system SHALL maintain backward compatibility with existing Agent API and behavior.

#### Scenario: Constructor signature compatibility

- **WHEN** Agent is instantiated with legacy options (model, host, systemPrompt, sessionContextFilePath)
- **THEN** it SHALL map them to appropriate provider configuration and maintain existing behavior

#### Scenario: Chat method signature unchanged

- **WHEN** Agent.chat() is called
- **THEN** it SHALL accept userMessage string and return Promise<string> as before

#### Scenario: Stream chat method signature unchanged

- **WHEN** Agent.streamChat() is called
- **THEN** it SHALL accept userMessage and onToken callback and return Promise<string> as before

#### Scenario: Context management methods unchanged

- **WHEN** Agent.clearContext(), getContext(), or setSystemPrompt() is called
- **THEN** they SHALL function identically to current implementation

#### Scenario: Tool management methods unchanged

- **WHEN** Agent.getTools() or saveContext() is called
- **THEN** they SHALL function identically to current implementation

#### Scenario: Existing tool implementations unchanged

- **WHEN** save_session_context, read_file, or write_file tools are executed
- **THEN** they SHALL execute with identical behavior to current implementation

### Requirement: System prompt handling

The system SHALL properly pass system prompts to providers regardless of provider type.

#### Scenario: System prompt as first message

- **WHEN** Agent constructs messages for provider
- **THEN** it SHALL include system prompt as a ChatMessage with role 'system' at the beginning

#### Scenario: System prompt updates reflected

- **WHEN** Agent.setSystemPrompt() is called
- **THEN** subsequent chat requests SHALL use the updated system prompt

#### Scenario: Provider handles system messages

- **WHEN** ChatRequest with system message is sent to provider
- **THEN** the provider SHALL handle it according to its API requirements (e.g., Bedrock extracts to system parameter)

### Requirement: Streaming token callbacks

The system SHALL preserve streaming token callback functionality across providers.

#### Scenario: Stream yields tokens to callback

- **WHEN** Agent.streamChat() receives ChatChunk from provider
- **THEN** it SHALL call onToken callback with the delta content

#### Scenario: Stream reports tool execution

- **WHEN** streaming chat results in tool calls
- **THEN** Agent SHALL call onToken with tool execution status messages as before

#### Scenario: Stream accumulates full response

- **WHEN** streaming chat completes
- **THEN** Agent SHALL return the full accumulated response string and store complete message in sessionContext

### Requirement: Error handling

The system SHALL handle provider errors gracefully and provide meaningful error messages.

#### Scenario: Provider error surfaces to caller

- **WHEN** provider throws ProviderError during chat
- **THEN** Agent SHALL catch it and throw a descriptive error to the caller

#### Scenario: Authentication error reporting

- **WHEN** provider throws ProviderAuthenticationError
- **THEN** Agent SHALL include provider name and authentication details in error message

#### Scenario: Model not found error reporting

- **WHEN** provider throws ProviderModelNotFoundError
- **THEN** Agent SHALL include provider name and requested model name in error message

#### Scenario: Generic error handling

- **WHEN** provider throws any other error
- **THEN** Agent SHALL wrap it with context about which provider failed
