## Context

The current `Agent` class is tightly coupled to Ollama, with direct imports and instantiation of the Ollama client. The agent uses Ollama-specific types (`Message`, `Tool`, `ToolCall`) and makes direct calls to `ollama.chat()` for both streaming and non-streaming interactions.

Current constraints:

- TypeScript/Node.js codebase
- Agent supports both streaming and non-streaming chat
- Agent maintains session context (message history)
- Agent has a tool execution system that needs to work with any provider
- Must maintain backward compatibility with existing agent functionality

## Goals / Non-Goals

**Goals:**

- Create a clean provider abstraction that decouples the agent from any specific LLM service
- Support both Ollama and Amazon Bedrock as providers
- Enable runtime provider switching without restarting the agent
- Preserve existing agent features (streaming, non-streaming, tool calls, session context)
- Use AWS SDK for JavaScript for Bedrock integration (not boto3 or Python-based tools)

**Non-Goals:**

- Supporting providers beyond Ollama and Bedrock in this phase
- Changing the external API of the Agent class
- Modifying the tool execution system's interface
- Adding new agent features beyond provider abstraction

## Decisions

### 1. Provider Interface Design

**Decision**: Use a TypeScript interface with abstract methods for common LLM operations.

**Rationale**: TypeScript interfaces provide compile-time type safety and clear contracts. The interface will define:

- `chat()`: Non-streaming completion
- `streamChat()`: Streaming completion
- Provider-agnostic types for messages, tools, and responses

**Alternatives considered**:

- Abstract class: Rejected because we don't need shared implementation logic
- Factory pattern only: Rejected because we need clear type contracts

**Interface structure**:

```typescript
interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<ChatChunk>;
  name: string;
}
```

### 2. Type Normalization

**Decision**: Create provider-agnostic types (`ChatMessage`, `ChatTool`, `ChatToolCall`, `ChatRequest`, `ChatResponse`) that each provider implementation will map to/from their native types.

**Rationale**: This insulates the agent from provider-specific type systems. Each provider handles translation between our common types and their API types.

**Alternatives considered**:

- Use Ollama types as standard: Rejected because it creates implicit coupling
- Use OpenAI types as standard: Rejected because neither provider is "standard"

### 3. Provider Configuration

**Decision**: Use a configuration object with a `provider` field that specifies which provider to use. Configuration includes provider-specific settings.

**Rationale**: Simple, explicit, and easily serializable for persistence.

```typescript
type ProviderConfig = {
  provider: "ollama" | "bedrock";
  ollama?: {
    host?: string;
    model: string;
  };
  bedrock?: {
    region?: string;
    model: string;
  };
};
```

**Alternatives considered**:

- Environment variables only: Rejected because runtime switching would be difficult
- Separate config files per provider: Rejected as overly complex for current needs

### 4. Runtime Provider Switching

**Decision**: Add a `switchProvider(config: ProviderConfig)` method to the Agent class that replaces the current provider instance while preserving session context.

**Rationale**: Enables experimentation and comparison between providers without losing conversation state.

**Alternatives considered**:

- Multiple provider instances: Rejected because it complicates context management
- Restart required: Rejected as it provides poor UX

### 5. Bedrock Integration Approach

**Decision**: Use `@aws-sdk/client-bedrock-runtime` NPM package for Bedrock API access.

**Rationale**: Official AWS SDK for JavaScript provides native TypeScript support, proper authentication, and follows AWS best practices.

**Alternatives considered**:

- aws-cli wrapper: Rejected due to added complexity of subprocess management and JSON parsing
- Direct HTTP calls: Rejected due to complexity of AWS signature v4 signing

### 6. File Structure

**Decision**:

```
src/
├── providers/
│   ├── types.ts          # Common types
│   ├── interface.ts      # LLMProvider interface
│   ├── ollama.ts         # Ollama implementation
│   └── bedrock.ts        # Bedrock implementation
└── agent.ts              # Refactored to use providers
```

**Rationale**: Clean separation of concerns, easy to add new providers.

**Alternatives considered**:

- Single file: Rejected as it would be too large
- Separate directory per provider: Rejected as premature for 2 providers

## Risks / Trade-offs

**[Risk]** Provider type mismatches could cause subtle bugs
→ **Mitigation**: Comprehensive unit tests for type translation in each provider

**[Risk]** Streaming behavior may differ between providers
→ **Mitigation**: Define clear streaming contracts in interface; add integration tests per provider

**[Risk]** Session context may not serialize properly if providers have incompatible tool call formats
→ **Mitigation**: Normalize tool calls to provider-agnostic format before storing in session context

**[Risk]** AWS SDK adds significant dependency size
→ **Mitigation**: Acceptable trade-off for official support; can investigate tree-shaking later

**[Trade-off]** Additional abstraction layer adds slight complexity
→ **Benefit**: Much easier to add providers, test, and maintain long-term

**[Trade-off]** Runtime provider switching may have edge cases with tool calls in progress
→ **Mitigation**: Document that switching should only occur between chat turns, not mid-conversation

## Migration Plan

1. **Phase 1: Create provider abstraction**
   - Define common types and interface
   - No changes to existing agent yet
   - Can be developed and tested in isolation

2. **Phase 2: Extract Ollama provider**
   - Implement `OllamaProvider` class
   - Test that it matches current Ollama behavior
   - Agent still uses Ollama directly (no breaking changes yet)

3. **Phase 3: Refactor agent to use provider interface**
   - Replace direct Ollama usage with provider interface
   - Default to Ollama for backward compatibility
   - Add provider configuration to Agent constructor
   - Add `switchProvider()` method

4. **Phase 4: Add Bedrock provider**
   - Implement `BedrockProvider` class
   - Add AWS SDK dependency
   - Test with Bedrock API

5. **Phase 5: Integration testing**
   - Test provider switching
   - Test session context preservation across providers
   - Test tool execution with both providers

**Rollback strategy**: Each phase is independently committable. If issues arise, can revert to previous phase. The agent will default to Ollama, maintaining current behavior.

## Open Questions

- Should we support multiple providers simultaneously (e.g., use Ollama for fast queries, Bedrock for complex ones)?
  - **Answer for now**: No, single provider at a time. Can revisit if use case emerges.

- How should we handle provider-specific features (e.g., if only one provider supports a feature)?
  - **Answer**: Document in provider implementation; throw clear error if unsupported feature is used.

- Should configuration be persisted to disk?
  - **Answer for now**: No, configuration is passed at runtime. Can add persistence later if needed.
