## Context

The propio agent hardcodes a generic system prompt in `src/index.ts` and passes it to the `Agent` constructor. There is no mechanism to load project-specific instructions from the filesystem. The Agent class already exposes `setSystemPrompt()` and accepts `systemPrompt` as a constructor option, so the infrastructure for dynamic prompts exists — only the discovery and loading pipeline is missing.

The AGENTS.md convention (see [openai/agents.md](https://github.com/openai/agents.md)) establishes a standard: place an `AGENTS.md` file in your repository to give coding agents project-specific context — build commands, testing procedures, coding conventions, and behavioral constraints. Multiple tools (GitHub Copilot, Claude Code via `CLAUDE.md`) already support this pattern.

## Goals / Non-Goals

**Goals:**
- Automatically discover `AGENTS.md` files in the working directory and ancestor directories
- Merge discovered instructions into the agent's system prompt at startup
- Support hierarchical files: root-level provides base context, deeper files add specificity
- Maintain full backward compatibility when no `AGENTS.md` exists
- Keep the implementation simple — read markdown, prepend to system prompt

**Non-Goals:**
- Parsing structured frontmatter (YAML headers, metadata) — treat the file as plain markdown content
- Allowing AGENTS.md to configure tool enable/disable state — this is a future enhancement
- Watching for file changes at runtime — discovery happens once at startup
- Supporting alternative filenames (CLAUDE.md, GEMINI.md, .agents, etc.)
- Providing a CLI flag to disable AGENTS.md loading — if the file exists, it's used

## Decisions

### 1. New module: `src/agentsMd.ts`

Create a single new module with two exported functions: `discoverAgentsMdFiles()` and `loadAgentsMdContent()`.

**Rationale**: Keeps discovery logic isolated from Agent class internals. The Agent class shouldn't know about filesystem discovery conventions — that's the CLI's concern. The module is imported by `src/index.ts` during bootstrap, not by `src/agent.ts`.

**Alternative considered**: Adding discovery methods directly to the Agent class. Rejected because the Agent class is provider/tool orchestration — file discovery is a startup concern.

### 2. Discovery walks upward from `process.cwd()`

`discoverAgentsMdFiles(startDir?)` searches for `AGENTS.md` starting from the given directory (defaulting to `process.cwd()`) and walking up parent directories. It stops at the filesystem root. Returns an array of absolute paths, ordered from root-most to deepest (closest to working directory).

**Rationale**: Matches the convention used by GitHub Copilot and the openai/agents.md spec — "the nearest AGENTS.md file in the directory tree takes precedence." Walking upward allows monorepo setups where a root AGENTS.md provides global guidance and subdirectory files add package-specific instructions.

**Alternative considered**: Only searching the working directory. Rejected because hierarchical discovery is a core part of the convention and enables monorepo support.

### 3. Content merging: concatenate root-to-leaf with separators

`loadAgentsMdContent(filePaths)` reads each file and concatenates their contents in root-to-leaf order, separated by a markdown heading indicating the source path. The result is a single string.

Example output for files found at `/repo/AGENTS.md` and `/repo/packages/api/AGENTS.md`:
```
## Project Instructions (from /repo/AGENTS.md)

<contents of root file>

## Project Instructions (from /repo/packages/api/AGENTS.md)

<contents of subdirectory file>
```

**Rationale**: Root-to-leaf order means general instructions come first and specific ones refine them. The separator headings provide attribution so the LLM understands the scope of each instruction block. Simple concatenation avoids complex merge logic.

**Alternative considered**: Only using the nearest (deepest) file. Rejected because this loses valuable root-level context in hierarchical projects.

### 4. System prompt composition: AGENTS.md content prepended to default prompt

In `src/index.ts`, the bootstrap flow becomes:
1. Discover AGENTS.md files
2. Load and merge their content
3. If content exists, construct system prompt as: `agentsMdContent + "\n\n" + defaultSystemPrompt`
4. If no files found, use the existing default prompt unchanged

**Rationale**: Prepending puts project-specific instructions first, giving them prominence. The default prompt's generic tool-usage guidance remains as a fallback baseline. This preserves existing behavior when no AGENTS.md is present.

**Alternative considered**: Replacing the default prompt entirely with AGENTS.md content. Rejected because the default prompt contains useful tool-usage guidance that AGENTS.md authors shouldn't need to replicate.

### 5. Use synchronous `fs.readFileSync` and `fs.existsSync` for discovery

Discovery and loading use synchronous Node.js `fs` APIs.

**Rationale**: This runs once at startup before the Agent is constructed. Synchronous reads are simpler, avoid async complexity in the bootstrap path, and the performance impact of reading a handful of small markdown files is negligible. The existing `getConfigPath()` and `loadProvidersConfig()` functions also use synchronous fs calls, maintaining consistency.

**Alternative considered**: Async `fs.promises` API. Rejected as unnecessary complexity for a startup-only, small-file operation.

### 6. No new dependencies

The implementation uses only Node.js built-in modules (`fs`, `path`). No markdown parsing library is needed since the content is injected as-is into the system prompt.

**Rationale**: The LLM interprets the markdown natively. Parsing it would add complexity without benefit.

## Risks / Trade-offs

**[Large AGENTS.md files consume context window]** → The implementation reads files as-is with no size limit. Extremely large files could reduce available context for conversation. Mitigation: this is an author concern, not a runtime concern. Document a recommendation to keep AGENTS.md concise. A future enhancement could add a size warning.

**[No validation of AGENTS.md content]** → Malicious or poorly-written instructions could cause the agent to behave unexpectedly. Mitigation: this is inherent to the convention — the agent trusts project files the same way it trusts the user. The file must be deliberately placed in the project.

**[Synchronous file reads block the event loop at startup]** → For the expected case (0-5 small files), this is sub-millisecond. Only a concern if someone has deeply nested directories with hundreds of levels. Mitigation: the upward walk is bounded by filesystem root, and each check is a single `existsSync` call.

**[No caching across sessions]** → Files are re-read on every agent startup. Mitigation: startup is infrequent and the reads are fast. Caching would add complexity for negligible benefit.
