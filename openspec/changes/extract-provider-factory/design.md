## Context

The Agent class currently violates the Open/Closed Principle by importing concrete provider implementations directly:

```typescript
import { OllamaProvider } from './providers/ollama';
import { BedrockProvider } from './providers/bedrock';
```

The `createProvider()` method in Agent contains provider instantiation logic with switch statements on provider type. This means every new provider requires:
1. Adding an import to Agent.ts
2. Modifying the createProvider() switch statement
3. Testing changes to the Agent class

This couples the Agent to all provider implementations, defeating the purpose of the LLMProvider interface abstraction. The Agent should only depend on the interface, not concrete implementations.

**Current State:**
- Agent.ts imports OllamaProvider and BedrockProvider directly
- createProvider() method exists in Agent class with switch logic
- getModelFromConfig() helper method extracts model from config
- Legacy constructor options (model, host) coexist with providerConfig

**Constraints:**
- Cannot change ProviderConfig structure (external contract)
- Must work with existing OllamaProvider and BedrockProvider implementations
- Should follow existing codebase patterns
- Early development phase - breaking changes acceptable for cleaner architecture

## Goals / Non-Goals

**Goals:**
- Decouple Agent class from concrete provider implementations
- Enable new providers to be added without modifying Agent.ts
- Centralize provider instantiation logic in a dedicated factory module
- Keep Agent constructor clean - only accept ProviderConfig
- Follow established factory pattern best practices

**Non-Goals:**
- Changing the ProviderConfig interface or structure
- Modifying existing provider implementations
- Adding dependency injection frameworks
- Creating a plugin system for providers (future enhancement)
- Runtime provider registration (providers still compiled in)
- Maintaining backward compatibility with legacy constructor options (model, host, systemPrompt)

## Decisions

### Decision 1: Factory Module Location

**Choice:** Create `src/providers/factory.ts` as a standalone module

**Rationale:**
- Keeps all provider-related code in `src/providers/` directory
- Factory is logically part of the provider abstraction, not the Agent
- Makes the factory reusable by other components if needed
- Clear separation of concerns

**Alternatives Considered:**
- Inline in `config.ts`: Would bloat the config module with instantiation logic
- Separate `src/factory.ts`: Would be less discoverable and break module cohesion

### Decision 2: Factory Function Signature

**Choice:** Export a single function `createProvider(config: ProviderConfig): LLMProvider`

**Rationale:**
- Simple, functional approach matches TypeScript conventions
- No need for a factory class (no state to maintain)
- Type-safe through ProviderConfig parameter
- Returns LLMProvider interface, hiding concrete implementations

**Alternatives Considered:**
- Factory class with static methods: Unnecessary complexity for stateless operation
- Multiple factory functions per provider: Would require caller to know provider type

### Decision 3: Error Handling Strategy

**Choice:** Throw descriptive errors for unknown provider types with suggestions

**Rationale:**
- Fail fast with clear error messages
- Helps developers catch configuration mistakes early
- Suggests valid provider names in error message
- Consistent with existing error handling patterns

**Error Format:**
```typescript
throw new Error(`Unknown provider type: "${config.provider}". Valid providers: ollama, bedrock`);
```

### Decision 4: Import Strategy in Factory

**Choice:** Factory imports all provider implementations, uses switch statement on provider type

**Rationale:**
- All providers are statically compiled into the application
- Switch statement provides type narrowing for TypeScript
- Clear, explicit mapping between config.provider string and implementation
- Easy to extend with new cases

**Code Pattern:**
```typescript
import { OllamaProvider } from './ollama';
import { BedrockProvider } from './bedrock';

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider(config.ollama);
    case 'bedrock':
      return new BedrockProvider(config.bedrock);
    default:
      throw new Error(`Unknown provider type...`);
  }
}
```

**Alternatives Considered:**
- Dynamic imports: Would complicate type safety and add async complexity
- Registry pattern: Over-engineering for current needs (only 2 providers)

### Decision 5: Move Helper Methods

**Choice:** Move `getModelFromConfig()` into factory module as `extractModelFromConfig()`

**Rationale:**
- Model extraction is provider configuration concern, not Agent concern
- Co-locates related logic (provider creation + config parsing)
- Keeps Agent focused on orchestration, not config parsing
- Reusable by other components

**Alternatives Considered:**
- Keep in Agent: Mixes concerns, Agent shouldn't parse config details
- Duplicate logic: Violates DRY principle

## Risks / Trade-offs

### Risk: Import Cycle
**Risk:** Factory imports providers, providers might need factory → circular dependency
**Mitigation:** Current providers don't need factory. If future providers require composition, use dependency injection or provider registry pattern.

### Risk: Type Safety with Config
**Risk:** Type narrowing from ProviderConfig to specific config (OllamaConfig, BedrockConfig) requires casting
**Mitigation:** Use TypeScript discriminated unions if config types become complex. Current any-cast is acceptable for 2 providers with validated switch statement.

### Trade-off: Static vs Dynamic Provider Loading
**Choice:** Static imports (all providers compiled in)
**Trade-off:** Larger bundle size vs simpler code and better type safety
**Justification:** Only 2 providers currently, static imports provide better DX and eliminate async complexity. Can revisit if provider count grows significantly (5+).

### Trade-off: Factory Purity
**Choice:** Factory has knowledge of all providers
**Trade-off:** Adding providers requires factory changes vs complete decoupling
**Justification:** Acceptable trade-off. Factory is the single point of change (better than Agent being the point of change). Future: could implement registry pattern if needed.

### Risk: Test Impact
**Risk:** Existing Agent tests may break if factory throws different errors
**Mitigation:** Review and update tests during implementation. Factory should throw errors consistent with current behavior.

## Migration Plan

**BREAKING CHANGE** - Agent constructor API is simplified to require ProviderConfig.

**Breaking Changes:**
- Remove legacy constructor options: `model`, `host`
- Agent constructor now requires `providerConfig` parameter
- Update `src/index.ts` to use new constructor API

**Migration Example:**
```typescript
// OLD (no longer supported)
const agent = new Agent({
  model: 'qwen3-coder:30b',
  host: 'http://localhost:11434'
});

// NEW (required)
const agent = new Agent({
  providerConfig: {
    provider: 'ollama',
    ollama: {
      model: 'qwen3-coder:30b',
      host: process.env.OLLAMA_HOST || 'http://localhost:11434'
    }
  },
  systemPrompt: '...',
  sessionContextFilePath: '...'
});
```

**Implementation Steps:**
1. Create factory module with tests
2. Update Agent constructor to only accept providerConfig (remove model/host options)
3. Update Agent to use factory
4. Update src/index.ts to use new constructor API
5. Run full test suite and update tests
6. Update inline documentation

**Rollback Strategy:**
- Simple git revert - no data changes, no external API changes
- All changes contained in application code

## Open Questions

None - design is complete and ready for implementation.
