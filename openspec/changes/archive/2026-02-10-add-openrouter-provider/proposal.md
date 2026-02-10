## Why

OpenRouter provides unified access to hundreds of AI models through a single OpenAI-compatible API endpoint, enabling cost-effective model selection with automatic fallbacks and intelligent routing. Adding OpenRouter as a provider expands the agent's model options to include affordable models that support modern tool calling capabilities, reducing operational costs while maintaining functionality.

## What Changes

- Add OpenRouter as a new provider type alongside Ollama and Bedrock
- Implement `OpenRouterProvider` class that follows the `LLMProvider` interface
- Add OpenRouter configuration support to provider config types
- Support both streaming and non-streaming completions
- Support tool calling (function calling) with proper translation between provider-agnostic and OpenRouter formats
- Add OpenRouter-specific error handling for authentication, rate limits, and model availability
- Update provider factory to instantiate OpenRouter provider instances
- Add OpenRouter provider configuration to JSON schema and examples

## Capabilities

### New Capabilities

- `openrouter-provider`: OpenRouter implementation of the LLMProvider interface, supporting chat completions, streaming, and tool calling through OpenRouter's OpenAI-compatible API

### Modified Capabilities

- `multi-provider-config`: Extend configuration types to include OpenRouterProviderConfig with API key and optional headers
- `provider-factory`: Update factory to handle 'openrouter' provider type and instantiate OpenRouterProvider instances

## Impact

**New Files:**

- `src/providers/openrouter.ts` - OpenRouter provider implementation

**Modified Files:**

- `src/providers/config.ts` - Add OpenRouterProviderConfig interface
- `src/providers/factory.ts` - Add OpenRouter case to provider factory
- `.propio/providers.json` (example) - Add OpenRouter provider configuration example
- `README.md` - Document OpenRouter provider usage

**Dependencies:**

- No new npm dependencies required (uses native fetch for HTTP requests)
- Requires OpenRouter API key (environment variable or config file)

**Configuration:**

- OpenRouter requires an API key for authentication
- Optional HTTP headers for site tracking (HTTP-Referer, X-Title)
- API endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Uses OpenAI-compatible request/response format

**API Compatibility:**

- OpenRouter's API is OpenAI-compatible, simplifying implementation
- Supports tool calling with the same format as OpenAI
- Streaming uses server-sent events (SSE) format
- Error responses follow standard HTTP status codes
