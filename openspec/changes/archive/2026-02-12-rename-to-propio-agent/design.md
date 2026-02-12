## Context

The application is currently named "ollama-agent" throughout the codebase, package configuration, and documentation. This name was appropriate initially but now misleads users into thinking the agent only works with Ollama. The agent actually supports multiple LLM providers (Ollama, Bedrock, OpenRouter) through a provider abstraction layer.

This design outlines the approach for systematically renaming the application to "propio-agent" while preserving all references to the Ollama provider integration, which remains a legitimate component.

## Goals / Non-Goals

**Goals:**

- Rename the npm package from `ollama-agent` to `propio-agent`
- Update all user-facing documentation to reflect the new name
- Update code comments that reference the application name
- Ensure consistency across package.json, README, and documentation

**Non-Goals:**

- Changing any functionality or behavior
- Renaming the `ollama` npm package dependency (this is an external package)
- Renaming `src/providers/ollama.ts` or Ollama provider code (these correctly describe the provider)
- Updating OpenSpec archived changes (historical records should remain as-is)
- Creating backwards compatibility or package aliases

## Decisions

### Decision 1: Scope of Rename

**Choice**: Rename only application-level references, not provider-specific code.

**Rationale**: The term "ollama" appears in two contexts:

1. **Application name**: "ollama-agent" as the package/project name
2. **Provider references**: The Ollama provider integration code

Only #1 should be renamed. Provider code correctly describes what it integrates with.

**Alternatives considered**:

- Rename everything containing "ollama" → Would incorrectly rename provider code
- Create an alias package → Unnecessary complexity for an internal project

### Decision 2: Archive Handling

**Choice**: Leave OpenSpec archived changes unchanged, only update active specs and documentation.

**Rationale**: Archived changes are historical records that document past development. Changing them would alter historical context. Only current/active documentation should reflect the new name.

**Alternatives considered**:

- Update all archives → Would misrepresent historical state
- Add notes to archives → Unnecessary; new changes will naturally use the new name

### Decision 3: Package Lock Handling

**Choice**: Regenerate `package-lock.json` after updating `package.json`.

**Rationale**: The lock file contains package name references that are automatically managed by npm. Running `npm install` after the package.json change will correctly update it.

**Alternatives considered**:

- Manually edit package-lock.json → Error-prone and unnecessary

### Decision 4: Search Strategy

**Choice**: Use case-insensitive search for "ollama-agent" and "ollama agent" in documentation, case-sensitive for code.

**Rationale**: Documentation may use various capitalizations, but code references should be exact. The provider files contain "ollama" without "-agent", so case-sensitive filtering prevents false matches.

**Alternatives considered**:

- Global find-and-replace → Would catch provider code incorrectly
- Manual file-by-file review → Time-consuming but used as verification step

## Risks / Trade-offs

**Risk**: Accidentally renaming provider code
→ **Mitigation**: Explicit exclusion list: `src/providers/ollama.ts`, `src/providers/__tests__/ollama.test.ts`, and any file paths containing `/ollama.` or `ollama-provider`

**Risk**: Missing references in documentation
→ **Mitigation**: Search includes common variations: "ollama-agent", "ollama agent", "Ollama Agent", "ollama_agent"

**Risk**: Breaking local development environments
→ **Mitigation**: Developers will need to run `npm install` after pulling changes to update node_modules. Document this in commit message.

**Trade-off**: No package migration strategy
Since this is an internal project (not published to npm registry), there's no need for deprecation notices or migration paths. This simplifies the change but assumes no external dependencies.
