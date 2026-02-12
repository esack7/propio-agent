## 1. Create the agentsMd module

- [x] 1.1 Create `src/agentsMd.ts` with the `discoverAgentsMdFiles` function that walks up from a start directory (defaulting to `process.cwd()`) checking for `AGENTS.md` via `fs.existsSync`, stopping at filesystem root, and returning absolute paths ordered root-most to deepest
- [x] 1.2 Add the `loadAgentsMdContent` function to `src/agentsMd.ts` that reads an array of file paths via `fs.readFileSync` (UTF-8), prepends each with a `## Project Instructions (from <path>)` heading, and returns the concatenated string (or empty string for empty input)
- [x] 1.3 Add the `composeSystemPrompt` function to `src/agentsMd.ts` that prepends non-empty AGENTS.md content to the default system prompt separated by two newlines, or returns the default prompt unchanged when content is empty

## 2. Integrate into Agent constructor

- [x] 2.1 Add optional `agentsMdContent` parameter to the Agent constructor options type in `src/agent.ts`
- [x] 2.2 Update the Agent constructor's system prompt assignment to prepend `agentsMdContent` (if non-empty) to the system prompt, separated by two newlines

## 3. Integrate into CLI bootstrap

- [x] 3.1 Update `src/index.ts` to import `discoverAgentsMdFiles`, `loadAgentsMdContent`, and `composeSystemPrompt` from `./agentsMd.js`
- [x] 3.2 Add AGENTS.md discovery and loading calls before Agent construction in `main()`: discover files, load content, compose system prompt, and pass the result to the Agent constructor

## 4. Tests

- [x] 4.1 Write unit tests for `discoverAgentsMdFiles`: single file in cwd, file in ancestor, multiple files at different levels (verify root-to-leaf order), no files found (empty array), custom start directory, stops at filesystem root
- [x] 4.2 Write unit tests for `loadAgentsMdContent`: single file, multiple files merged with source headings, empty array returns empty string, UTF-8 encoding
- [x] 4.3 Write unit tests for `composeSystemPrompt`: non-empty content prepended with two-newline separator, empty content returns default prompt unchanged
- [x] 4.4 Write unit tests for Agent constructor `agentsMdContent` option: verify system prompt includes prepended content when provided, verify unchanged behavior when omitted or empty
