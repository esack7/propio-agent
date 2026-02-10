## Why

The agent is currently tightly coupled to Ollama as the LLM provider, making it difficult to add alternative providers or switch between them. Abstracting the provider interface will enable flexible LLM provider selection and runtime switching, allowing the agent to support multiple backends like Ollama and Amazon Bedrock.

## What Changes

- Extract LLM provider logic from agent core into an abstraction layer
- Create a provider interface that defines standard methods for LLM interactions
- Implement Ollama provider as a concrete implementation of the interface
- Implement Amazon Bedrock provider using aws-cli for API access
- Add runtime provider configuration and switching capability
- Maintain backward compatibility with existing agent functionality

## Capabilities

### New Capabilities

- `llm-provider-abstraction`: Core provider interface and abstraction layer for LLM interactions
- `ollama-provider`: Ollama-specific provider implementation
- `bedrock-provider`: Amazon Bedrock provider implementation using aws-cli

### Modified Capabilities

- `agent-core`: Agent will be refactored to use the provider abstraction instead of direct Ollama calls

## Impact

- **Code**: Agent core will be refactored to decouple LLM provider logic; new provider modules will be created
- **Dependencies**: May need to add AWS SDK for JavaScript or aws-cli wrapper for Bedrock integration
- **Configuration**: New configuration mechanism needed for provider selection and runtime switching
- **APIs**: Internal API between agent and LLM provider will change, but external agent interface remains the same
