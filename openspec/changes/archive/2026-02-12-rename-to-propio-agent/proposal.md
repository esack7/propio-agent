## Why

The application needs to be renamed from "ollama-agent" to "propio-agent" to better reflect its purpose as a general-purpose AI agent framework. The current name "ollama-agent" implies a tight coupling to the Ollama provider, when in fact the agent supports multiple LLM providers (Ollama, Bedrock, OpenRouter) through a pluggable architecture.

## What Changes

- Update package name from `ollama-agent` to `propio-agent` in package.json
- Update package description to reflect general-purpose nature
- Update all user-facing documentation (README.md, comments) to use "propio-agent" nomenclature
- Update references to the application name in:
  - Documentation files
  - Code comments
  - OpenSpec documentation where the application is referenced
  - Configuration examples
- **Note**: The `ollama` npm package dependency and `src/providers/ollama.ts` files remain unchanged as they refer to the Ollama provider integration, not the application name

## Capabilities

### New Capabilities

None - this is a naming/branding change only.

### Modified Capabilities

None - this change does not affect the behavioral requirements of any existing capabilities. It updates naming and documentation but does not modify any spec-level functionality.

## Impact

**Affected Files**:

- `package.json` - name and description fields
- `package-lock.json` - package name references
- `README.md` - application name and references
- Documentation in `openspec/` directories that reference the application name
- Code comments that reference "ollama-agent" as the application name
- `.devcontainer/devcontainer.json` - if it references the project name

**Not Affected**:

- `ollama` npm package dependency (provider integration)
- `src/providers/ollama.ts` and related Ollama provider files (these are about the provider, not the app)
- Existing spec requirements (no behavioral changes)
- Test functionality (only test descriptions/comments may need updates)

**Breaking Changes**: None - this is an internal rename that does not affect APIs or external integrations.
