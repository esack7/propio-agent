## ADDED Requirements

### Requirement: OpenRouter provider implementation

The system SHALL provide an OpenRouterProvider class that implements the LLMProvider interface for accessing OpenRouter's unified API.

#### Scenario: OpenRouter provider implements LLMProvider interface

- **WHEN** OpenRouterProvider is instantiated
- **THEN** it SHALL implement the LLMProvider interface with chat(), streamChat(), and name property

#### Scenario: Provider name identifies OpenRouter

- **WHEN** OpenRouterProvider is created
- **THEN** its name property SHALL be 'openrouter'

#### Scenario: Provider accepts configuration options

- **WHEN** OpenRouterProvider constructor is called
- **THEN** it SHALL accept an options object with model (string), apiKey (optional string), httpReferer (optional string), and xTitle (optional string) fields

#### Scenario: API key from configuration or environment

- **WHEN** OpenRouterProvider is instantiated without apiKey in options
- **THEN** it SHALL read the API key from OPENROUTER_API_KEY environment variable
- **AND** it SHALL throw ProviderAuthenticationError if neither is provided

### Requirement: Non-streaming chat completions

The system SHALL support non-streaming chat completions through OpenRouter's API.

#### Scenario: Send chat request to OpenRouter API

- **WHEN** chat() method is called with a ChatRequest
- **THEN** it SHALL send a POST request to https://openrouter.ai/api/v1/chat/completions
- **AND** it SHALL include Authorization header with "Bearer {apiKey}" format

#### Scenario: Include optional site tracking headers

- **WHEN** chat() method is called and httpReferer or xTitle are configured
- **THEN** it SHALL include HTTP-Referer and/or X-Title headers in the request

#### Scenario: Translate ChatMessage to OpenAI format

- **WHEN** chat() method receives ChatRequest with ChatMessage array
- **THEN** it SHALL convert messages to OpenAI format with role, content, and optional tool_calls fields

#### Scenario: Translate ChatTool to OpenAI format

- **WHEN** chat() method receives ChatRequest with tools array
- **THEN** it SHALL convert ChatTool objects to OpenAI tools format with type: 'function', function.name, function.description, and function.parameters

#### Scenario: Parse OpenRouter response to ChatResponse

- **WHEN** OpenRouter API returns a successful response
- **THEN** it SHALL extract the assistant message from choices[0].message
- **AND** it SHALL translate to ChatMessage format with role, content, and optional toolCalls

#### Scenario: Map finish_reason to stopReason

- **WHEN** OpenRouter response includes finish_reason
- **THEN** it SHALL map 'stop' to 'end_turn', 'tool_calls' to 'tool_use', 'length' to 'max_tokens', and other values to 'end_turn'

### Requirement: Streaming chat completions

The system SHALL support streaming chat completions with server-sent events (SSE) parsing.

#### Scenario: Send streaming chat request

- **WHEN** streamChat() method is called with a ChatRequest
- **THEN** it SHALL send a POST request with stream: true in the request body
- **AND** it SHALL return an AsyncIterable<ChatChunk>

#### Scenario: Parse SSE stream format

- **WHEN** streamChat() receives response stream
- **THEN** it SHALL parse lines starting with "data: " as JSON chunks
- **AND** it SHALL skip lines that don't start with "data: "

#### Scenario: Handle [DONE] marker

- **WHEN** streamChat() encounters "data: [DONE]"
- **THEN** it SHALL terminate the stream and return

#### Scenario: Yield content deltas

- **WHEN** streamChat() receives a chunk with choices[0].delta.content
- **THEN** it SHALL yield a ChatChunk with delta field containing the incremental text

#### Scenario: Accumulate tool calls from stream

- **WHEN** streamChat() receives chunks with choices[0].delta.tool_calls
- **THEN** it SHALL accumulate complete tool calls across multiple chunks
- **AND** it SHALL yield a final ChatChunk with toolCalls array when finish_reason is 'tool_calls'

#### Scenario: Handle streaming errors mid-stream

- **WHEN** streamChat() encounters a network error or malformed chunk
- **THEN** it SHALL throw an appropriate ProviderError and terminate the stream

#### Scenario: Handle partial chunks with buffer

- **WHEN** streamChat() receives incomplete JSON data in a read
- **THEN** it SHALL buffer partial data until a complete line is received

### Requirement: Tool calling support

The system SHALL support tool calling (function calling) in both streaming and non-streaming modes.

#### Scenario: Send tools in request

- **WHEN** chat() or streamChat() receives ChatRequest with tools array
- **THEN** it SHALL include tools field in the OpenRouter API request body

#### Scenario: Receive tool_calls in response

- **WHEN** OpenRouter response includes message.tool_calls array
- **THEN** it SHALL translate each tool call to ChatToolCall format with function.name and function.arguments

#### Scenario: Parse tool call arguments

- **WHEN** OpenRouter returns tool_calls with function.arguments as JSON string
- **THEN** it SHALL parse the JSON string to an object for ChatToolCall.function.arguments

#### Scenario: Preserve tool call IDs

- **WHEN** OpenRouter response includes tool_calls with id field
- **THEN** it SHALL preserve the id in ChatToolCall.id for use in subsequent tool result messages

#### Scenario: Handle tool role messages

- **WHEN** chat() receives ChatMessage with role: 'tool'
- **THEN** it SHALL include tool_call_id field in the message to reference the original tool call

### Requirement: Error handling and translation

The system SHALL translate OpenRouter API errors to standard ProviderError types.

#### Scenario: 401 Unauthorized error

- **WHEN** OpenRouter API returns 401 status code
- **THEN** it SHALL throw ProviderAuthenticationError with message indicating invalid API key

#### Scenario: 429 Rate limit error

- **WHEN** OpenRouter API returns 429 status code
- **THEN** it SHALL throw ProviderRateLimitError with rate limit message
- **AND** it SHALL extract retry-after header value if present and include it in retryAfterSeconds field

#### Scenario: 404 Model not found error

- **WHEN** OpenRouter API returns 404 status code with model-related error message
- **THEN** it SHALL throw ProviderModelNotFoundError with the requested model name

#### Scenario: 402 Payment required error

- **WHEN** OpenRouter API returns 402 status code
- **THEN** it SHALL throw ProviderError with message indicating insufficient credits

#### Scenario: 5xx Server error

- **WHEN** OpenRouter API returns 500, 502, 503, or 504 status code
- **THEN** it SHALL throw ProviderError with message indicating OpenRouter service issue

#### Scenario: Network connection errors

- **WHEN** fetch fails with ECONNREFUSED, ETIMEDOUT, or network error
- **THEN** it SHALL throw ProviderError with message indicating connection failure to OpenRouter API

#### Scenario: Preserve original error

- **WHEN** any error is thrown
- **THEN** the ProviderError SHALL include the original error in the originalError field for debugging

### Requirement: Request format compliance

The system SHALL generate API requests that comply with OpenRouter's OpenAI-compatible format.

#### Scenario: Required request fields

- **WHEN** generating an API request
- **THEN** it SHALL include model (string) and messages (array) fields

#### Scenario: Message format structure

- **WHEN** generating message objects
- **THEN** each message SHALL include role ('user' | 'assistant' | 'system' | 'tool') and content (string) fields

#### Scenario: Tool calls in assistant messages

- **WHEN** translating ChatMessage with toolCalls
- **THEN** it SHALL include tool_calls array in assistant messages with id, type: 'function', function.name, and function.arguments (as JSON string)

#### Scenario: Tool results in tool messages

- **WHEN** translating tool role messages
- **THEN** it SHALL include tool_call_id field referencing the original tool call

#### Scenario: Content-Type header

- **WHEN** making any API request
- **THEN** it SHALL include Content-Type: application/json header

#### Scenario: Model identifier format

- **WHEN** sending model field in request
- **THEN** it SHALL use OpenRouter's provider/model format (e.g., "openai/gpt-4o", "anthropic/claude-3.5-sonnet")

### Requirement: Response format handling

The system SHALL correctly parse OpenRouter's OpenAI-compatible response format.

#### Scenario: Parse non-streaming response structure

- **WHEN** parsing a non-streaming API response
- **THEN** it SHALL extract data from choices[0].message object

#### Scenario: Handle assistant role

- **WHEN** parsing response message
- **THEN** it SHALL verify message.role is 'assistant'

#### Scenario: Extract text content

- **WHEN** parsing response message
- **THEN** it SHALL extract message.content as the assistant's text response

#### Scenario: Extract tool calls

- **WHEN** response includes message.tool_calls array
- **THEN** it SHALL parse each tool call with id, type, function.name, and function.arguments fields

#### Scenario: Handle empty content with tool calls

- **WHEN** response has tool_calls but message.content is null or empty
- **THEN** it SHALL set ChatMessage.content to empty string and include toolCalls array

#### Scenario: Handle streaming delta structure

- **WHEN** parsing streaming chunks
- **THEN** it SHALL extract incremental data from choices[0].delta object

#### Scenario: Streaming finish_reason in final chunk

- **WHEN** streaming completes
- **THEN** the final chunk SHALL include choices[0].finish_reason indicating completion type
