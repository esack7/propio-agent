## ADDED Requirements

### Requirement: Load and merge AGENTS.md file contents

The system SHALL provide a `loadAgentsMdContent` function that reads an ordered list of AGENTS.md file paths and returns their merged content as a single string.

#### Scenario: Single file loaded

- **WHEN** `loadAgentsMdContent` is called with an array containing one file path
- **THEN** it SHALL return the file's content preceded by a markdown heading indicating the source path

#### Scenario: Multiple files merged in order

- **WHEN** `loadAgentsMdContent` is called with an array of file paths ordered root-to-leaf
- **THEN** it SHALL return the concatenated contents of all files, each preceded by a source heading, separated by blank lines, in the same root-to-leaf order

#### Scenario: Empty file list

- **WHEN** `loadAgentsMdContent` is called with an empty array
- **THEN** it SHALL return an empty string

### Requirement: Source attribution headings

The system SHALL prepend each file's content with a markdown heading that identifies the source path.

#### Scenario: Heading format for each file section

- **WHEN** a file at path `/repo/AGENTS.md` is loaded
- **THEN** its content SHALL be preceded by a heading in the format `## Project Instructions (from /repo/AGENTS.md)`

#### Scenario: Multiple headings for multiple files

- **WHEN** files at `/repo/AGENTS.md` and `/repo/packages/api/AGENTS.md` are loaded
- **THEN** the output SHALL contain two source headings, one for each file, in root-to-leaf order

### Requirement: Synchronous file reading

The system SHALL use synchronous filesystem APIs to read AGENTS.md file contents.

#### Scenario: Files read synchronously with UTF-8 encoding

- **WHEN** `loadAgentsMdContent` reads each file
- **THEN** it SHALL use synchronous filesystem APIs (e.g., `fs.readFileSync`) with UTF-8 encoding

### Requirement: Compose system prompt with AGENTS.md content

The system SHALL provide a `composeSystemPrompt` function that combines AGENTS.md content with the default system prompt.

#### Scenario: AGENTS.md content prepended to default prompt

- **WHEN** `composeSystemPrompt` is called with non-empty AGENTS.md content and a default system prompt
- **THEN** it SHALL return the AGENTS.md content followed by two newlines followed by the default system prompt

#### Scenario: No AGENTS.md content returns default prompt unchanged

- **WHEN** `composeSystemPrompt` is called with empty AGENTS.md content and a default system prompt
- **THEN** it SHALL return the default system prompt unchanged
