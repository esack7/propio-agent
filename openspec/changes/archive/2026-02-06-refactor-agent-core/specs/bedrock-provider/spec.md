## ADDED Requirements

### Requirement: Bedrock client initialization

The system SHALL provide a BedrockProvider class that implements the LLMProvider interface using the `@aws-sdk/client-bedrock-runtime` package (version 3.984.0 or higher).

#### Scenario: Provider initializes with region configuration

- **WHEN** BedrockProvider is instantiated with an AWS region
- **THEN** it SHALL create a BedrockRuntimeClient with the specified region

#### Scenario: Provider uses default region

- **WHEN** BedrockProvider is instantiated without a region
- **THEN** it SHALL default to 'us-east-1' as the AWS region

#### Scenario: Provider accepts AWS credentials

- **WHEN** BedrockProvider is instantiated
- **THEN** it SHALL use the AWS SDK's default credential provider chain (environment variables, IAM roles, shared credentials file)

#### Scenario: Provider identifier

- **WHEN** BedrockProvider name property is accessed
- **THEN** it SHALL return "bedrock"

### Requirement: Message type translation

The system SHALL translate between ChatMessage (provider-agnostic) and Bedrock's Message format for ConverseCommand.

#### Scenario: Translate ChatMessage to Bedrock Message

- **WHEN** a ChatMessage with role 'user' or 'assistant' is provided
- **THEN** the provider SHALL map it to Bedrock's Message format with role and content array

#### Scenario: Handle system messages

- **WHEN** a ChatMessage with role 'system' is provided
- **THEN** the provider SHALL extract it and pass as the `system` parameter to ConverseCommand (not in messages array)

#### Scenario: Translate content to Bedrock format

- **WHEN** a ChatMessage has text content
- **THEN** the provider SHALL create a Bedrock content block with `{text: string}` format

#### Scenario: Translate images to Bedrock format

- **WHEN** a ChatMessage includes images
- **THEN** the provider SHALL create Bedrock image content blocks with appropriate format and source

#### Scenario: Translate tool calls to Bedrock format

- **WHEN** a ChatMessage includes toolCalls from the assistant
- **THEN** the provider SHALL map them to Bedrock's toolUse content blocks with toolUseId, name, and input

#### Scenario: Handle tool results

- **WHEN** a ChatMessage has role 'tool'
- **THEN** the provider SHALL create a Bedrock toolResult content block with toolUseId, status, and content

#### Scenario: Translate Bedrock Message to ChatMessage

- **WHEN** Bedrock returns a Message in ConverseOutput
- **THEN** the provider SHALL extract text from content blocks and map to ChatMessage format

### Requirement: Tool definition translation

The system SHALL translate between ChatTool (provider-agnostic) and Bedrock's Tool specification format.

#### Scenario: Translate ChatTool to Bedrock ToolSpecification

- **WHEN** a ChatTool is provided in a request
- **THEN** the provider SHALL map it to Bedrock's toolSpec format with name, description, and inputSchema

#### Scenario: Translate JSON Schema parameters

- **WHEN** a ChatTool includes JSON Schema parameters
- **THEN** the provider SHALL map them to Bedrock's inputSchema with json format containing type, properties, and required fields

#### Scenario: Pass tools via toolConfig

- **WHEN** tools are present in a ChatRequest
- **THEN** the provider SHALL create a toolConfig object with tools array and pass to ConverseCommand

### Requirement: Non-streaming chat implementation

The system SHALL implement the chat() method using Bedrock's ConverseCommand API.

#### Scenario: Successful non-streaming request

- **WHEN** chat() is called with a ChatRequest
- **THEN** it SHALL create and send a ConverseCommand to BedrockRuntimeClient and return a ChatResponse

#### Scenario: Model identifier format

- **WHEN** chat() is called with a model in ChatRequest
- **THEN** it SHALL use Bedrock's model ID format (e.g., 'anthropic.claude-3-sonnet-20240229-v1:0')

#### Scenario: System prompt handling

- **WHEN** messages include a system message
- **THEN** the provider SHALL extract it and pass as the system parameter to ConverseCommand

#### Scenario: Tools configuration

- **WHEN** chat() is called with tools in ChatRequest
- **THEN** it SHALL translate tools and pass via toolConfig parameter

#### Scenario: Response includes message content

- **WHEN** ConverseCommand completes successfully
- **THEN** the provider SHALL extract content from output.message and map to ChatMessage

#### Scenario: Response includes stop reason

- **WHEN** ConverseCommand completes
- **THEN** the provider SHALL map Bedrock's stopReason to provider-agnostic stop reason ('end_turn', 'tool_use', 'max_tokens', or 'stop_sequence')

#### Scenario: Response includes tool calls

- **WHEN** ConverseCommand returns with tool use
- **THEN** the provider SHALL extract toolUse blocks and map to ChatToolCall objects

### Requirement: Streaming chat implementation

The system SHALL implement the streamChat() method using Bedrock's ConverseStreamCommand API.

#### Scenario: Successful streaming request

- **WHEN** streamChat() is called with a ChatRequest
- **THEN** it SHALL create and send a ConverseStreamCommand and yield ChatChunk objects

#### Scenario: Stream processes content delta events

- **WHEN** ConverseStreamCommand yields ContentBlockDeltaEvent
- **THEN** the provider SHALL extract delta.text and yield ChatChunk with delta content

#### Scenario: Stream processes message start

- **WHEN** ConverseStreamCommand yields MessageStartEvent
- **THEN** the provider SHALL initialize streaming context with assistant role

#### Scenario: Stream processes content block start

- **WHEN** ConverseStreamCommand yields ContentBlockStartEvent
- **THEN** the provider SHALL track the content block type (text or toolUse)

#### Scenario: Stream processes tool use blocks

- **WHEN** ConverseStreamCommand yields ContentBlockDeltaEvent with toolUse
- **THEN** the provider SHALL accumulate tool call information for final ChatChunk

#### Scenario: Stream completes with stop reason

- **WHEN** ConverseStreamCommand yields MessageStopEvent
- **THEN** the provider SHALL include stop reason in metadata

#### Scenario: Stream yields tool calls on completion

- **WHEN** streaming completes with tool use blocks
- **THEN** the provider SHALL yield a final ChatChunk containing all accumulated ChatToolCall objects

#### Scenario: Stream error handling

- **WHEN** ConverseStreamCommand encounters ModelStreamErrorException
- **THEN** the provider SHALL throw ProviderError with details from the stream error

### Requirement: Error handling

The system SHALL handle Bedrock-specific errors and translate them to standard ProviderError types.

#### Scenario: Authentication error handling

- **WHEN** Bedrock returns an authentication error (e.g., invalid credentials, expired token)
- **THEN** the provider SHALL throw ProviderAuthenticationError with AWS error details

#### Scenario: Model not found handling

- **WHEN** Bedrock returns ResourceNotFoundException for invalid model ID
- **THEN** the provider SHALL throw ProviderModelNotFoundError with the requested model ID

#### Scenario: Throttling error handling

- **WHEN** Bedrock returns ThrottlingException
- **THEN** the provider SHALL throw ProviderRateLimitError with retry-after information if available

#### Scenario: Validation error handling

- **WHEN** Bedrock returns ValidationException (e.g., invalid parameters)
- **THEN** the provider SHALL throw ProviderError with validation details

#### Scenario: Service error handling

- **WHEN** Bedrock returns InternalServerException or ServiceUnavailableException
- **THEN** the provider SHALL throw ProviderError indicating service unavailability

### Requirement: Model compatibility

The system SHALL support Bedrock models that implement the Converse API.

#### Scenario: Support Claude models

- **WHEN** a Claude model ID is specified (e.g., 'anthropic.claude-3-sonnet-20240229-v1:0')
- **THEN** the provider SHALL successfully invoke the model via ConverseCommand

#### Scenario: Support Amazon Nova models

- **WHEN** an Amazon Nova model ID is specified
- **THEN** the provider SHALL successfully invoke the model via ConverseCommand

#### Scenario: Support Meta Llama models

- **WHEN** a Meta Llama model ID is specified
- **THEN** the provider SHALL successfully invoke the model via ConverseCommand

#### Scenario: Support Mistral models

- **WHEN** a Mistral AI model ID is specified
- **THEN** the provider SHALL successfully invoke the model via ConverseCommand

#### Scenario: Verify streaming support

- **WHEN** streamChat() is called with a model
- **THEN** the provider SHALL use ConverseStreamCommand which supports all Converse-compatible models

### Requirement: AWS SDK integration

The system SHALL properly integrate with AWS SDK best practices.

#### Scenario: Use credential provider chain

- **WHEN** BedrockProvider is instantiated
- **THEN** it SHALL use AWS SDK's default credential resolution (environment variables, EC2 instance metadata, ECS task roles, shared credentials)

#### Scenario: Support credential configuration

- **WHEN** explicit AWS credentials are provided during initialization
- **THEN** the provider SHALL pass them to BedrockRuntimeClient

#### Scenario: Handle AWS SDK errors

- **WHEN** AWS SDK throws service errors
- **THEN** the provider SHALL extract error codes, messages, and request IDs for debugging

#### Scenario: Proper client cleanup

- **WHEN** BedrockProvider is no longer needed
- **THEN** it SHALL properly dispose of the BedrockRuntimeClient resources
