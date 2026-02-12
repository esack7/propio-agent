## Why

The propio agent currently uses a hardcoded generic system prompt ("You are a helpful AI coding assistant...") with no mechanism to load project-specific instructions. The emerging AGENTS.md convention (pioneered by OpenAI, adopted by GitHub Copilot, analogous to Claude Code's CLAUDE.md) provides a standardized, predictable location for project-specific agent instructions. Supporting AGENTS.md allows the propio agent to automatically adapt its behavior, constraints, and guidance per-project without manual configuration.

## What Changes

- Add AGENTS.md file discovery at agent startup, searching the working directory and parent directories up to a configurable boundary
- Parse discovered AGENTS.md files as markdown and inject their contents into the agent's system prompt
- Support hierarchical AGENTS.md files: a root-level file provides base instructions, while subdirectory files add context-specific guidance (closest file takes precedence for overlapping concerns)
- The agent's existing hardcoded system prompt becomes a fallback default when no AGENTS.md is found
- Discovery is automatic and opt-in by file presence — no AGENTS.md means existing behavior is unchanged

## Capabilities

### New Capabilities
- `agents-md-discovery`: File discovery logic for locating AGENTS.md files in the directory hierarchy (working directory and ancestors), with support for multiple files at different levels
- `agents-md-loading`: Parsing AGENTS.md content and integrating it into the agent's system prompt, including merging instructions from multiple hierarchy levels

### Modified Capabilities
- `agent-core`: The Agent class initialization must support receiving and applying discovered AGENTS.md instructions as part of the system prompt construction

## Impact

- **Code**: New module(s) in `src/` for AGENTS.md discovery and loading; modifications to `src/index.ts` bootstrap flow and `src/agent.ts` system prompt handling
- **APIs**: Agent constructor options extended with optional AGENTS.md content; `systemPrompt` construction becomes dynamic
- **Dependencies**: No new external dependencies expected — uses Node.js `fs` APIs and existing path utilities
- **Behavior**: Fully backward-compatible. Without an AGENTS.md file present, behavior is identical to current. With one present, the system prompt is augmented with its contents
- **Docker/Sandbox**: AGENTS.md files within the mounted workspace directory are automatically accessible; no sandbox configuration changes needed
