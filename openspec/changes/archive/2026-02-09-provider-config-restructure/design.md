## Context

The current `ProviderConfig` is implemented as a discriminated union:
```typescript
{ provider: 'ollama', ollama: { model, host } }
{ provider: 'bedrock', bedrock: { model, region } }
```

This design works for 2 providers but doesn't scale because:
- Adding a 3rd provider requires modifying the union type and all factory code
- Each provider requires nested configuration objects
- No support for multiple models per provider
- No declarative way to configure defaults

The system is in active development with no production deployments, making breaking changes acceptable. Test files use inline config objects. The entry point (`src/index.ts`) uses inline config for demonstration purposes.

## Goals / Non-Goals

**Goals:**
- Support 1-100 providers in a single configuration file
- Support multiple models per provider with explicit defaults
- Flatten provider-specific options (no nesting)
- Load configuration from external JSON files
- Provide runtime provider/model switching using names from config
- Maintain type safety with discriminated unions based on `type` field

**Non-Goals:**
- Backward compatibility with old `ProviderConfig` format (breaking change accepted)
- Hot-reloading of configuration files
- Configuration validation beyond structure (e.g., testing that Ollama host is reachable)
- Configuration secrets management (host URLs and regions are not considered secrets)

## Decisions

### Decision 1: JSON file-based configuration

**Chosen:** External JSON files with synchronous loading at Agent initialization

**Alternatives considered:**
- Environment variables: Too cumbersome for complex nested config with multiple providers/models
- Database or remote config: Over-engineering for a CLI agent tool
- YAML/TOML: JSON is simpler, has native TypeScript support, and sufficient for this use case

**Rationale:** JSON provides a good balance of readability, type safety (via interfaces), and ease of maintenance. Synchronous loading is acceptable since Agent initialization happens once at startup.

### Decision 2: Support both object and file path for Agent constructor

**Chosen:** `providersConfig: ProvidersConfig | string` parameter that accepts either a config object or file path

**Alternatives considered:**
- File path only: Would force all code (including tests) to create temp files
- Object only: Would lose the benefit of declarative configuration
- Separate parameters: Creates API confusion

**Rationale:** Flexibility for both use cases - tests can use inline objects, production can use file paths. Type union makes the API clear.

### Decision 3: Flat provider-specific options

**Chosen:** Provider-specific fields at the top level of each provider config:
```typescript
{ name: 'local-ollama', type: 'ollama', host: 'http://localhost:11434', ... }
```

**Alternatives considered:**
- Keep nested structure: Doesn't scale well and creates unnecessary nesting
- Separate options object: `{ type: 'ollama', options: { host } }` - harder to type safely

**Rationale:** Flat structure is more readable and easier to validate. TypeScript discriminated unions work naturally with top-level `type` field.

### Decision 4: Three-tier resolution (config default → provider override → model override)

**Chosen:**
```typescript
new Agent({
  providersConfig,           // contains config.default
  providerName?: string,     // overrides config.default
  modelKey?: string          // overrides provider.defaultModel
})
```

**Alternatives considered:**
- Single tier (config only): Less flexible for runtime decisions
- Four+ tiers: Over-complicated

**Rationale:** Supports common use cases (use defaults, override provider, override model) without excessive complexity. Follows principle of "sensible defaults with escape hatches."

### Decision 5: Breaking change to Agent constructor

**Chosen:** Replace `providerConfig` parameter with new `providersConfig` parameter, no migration path

**Alternatives considered:**
- Support both old and new: Creates maintenance burden and API confusion
- Deprecation warnings: Not worth the complexity for pre-1.0 software

**Rationale:** Clean break is easier to understand and maintain. All existing code is in this repo and easy to update in one change.

### Decision 6: Model represented as { name, key } instead of just string

**Chosen:**
```typescript
models: [
  { name: 'Llama 3.2 3B', key: 'llama3.2:3b' },
  { name: 'Llama 3.2 90B', key: 'llama3.2:90b' }
]
```

**Alternatives considered:**
- Simple string array: `models: ['llama3.2:3b', 'llama3.2:90b']`
- Key only with computed name: `models: [{ key: 'llama3.2:3b' }]`

**Rationale:** Separating human-readable name from technical key makes config more maintainable and enables future UI work. Keys are what get passed to providers.

## Risks / Trade-offs

**[Risk]** File loading can fail (file not found, malformed JSON, missing fields)
→ **Mitigation:** Comprehensive validation in `loadProvidersConfig()` with descriptive error messages. Document required structure in JSON schema comments.

**[Risk]** Breaking change requires updating all existing Agent instantiations
→ **Mitigation:** This is unavoidable. Update all test files and examples in single change. Acceptable for pre-1.0 software.

**[Risk]** Configuration complexity increases (more fields, nested arrays)
→ **Mitigation:** Provide default `providers.json` with examples. Use clear field names and TypeScript types for documentation.

**[Trade-off]** Synchronous file loading blocks Agent initialization
→ **Accepted:** Initialization happens once at startup. Adding async would complicate API for minimal benefit.

**[Trade-off]** No runtime validation of provider availability (e.g., Ollama host reachability)
→ **Accepted:** Fast fail on first chat request is sufficient. Eager validation would slow initialization and complicate error handling.

## Migration Plan

**Phase 1: Implement new types and utilities**
1. Rewrite `src/providers/config.ts` with new interfaces
2. Create `src/providers/configLoader.ts` with loading and resolution functions
3. Add unit tests for config loading and validation

**Phase 2: Update factory**
1. Modify `src/providers/factory.ts` to accept `ProviderConfig` with `type` field and optional `modelKey` parameter
2. Update factory tests

**Phase 3: Update Agent**
1. Change Agent constructor signature to accept `providersConfig`, optional `providerName`, and `modelKey`
2. Update initialization to call configLoader utilities
3. Update `switchProvider()` to accept provider name and model key
4. Update Agent tests

**Phase 4: Update entry point and examples**
1. Create `providers.json` at project root
2. Update `src/index.ts` to load from file
3. Update integration tests

**Rollback strategy:** Not applicable - this is a development change with no production deployment. Git revert is sufficient if issues arise.

## Open Questions

None - requirements and approach are clear from the proposal and specs.
