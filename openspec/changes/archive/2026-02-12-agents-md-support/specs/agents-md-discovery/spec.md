## ADDED Requirements

### Requirement: Discover AGENTS.md files by walking up the directory hierarchy

The system SHALL provide a `discoverAgentsMdFiles` function that locates all `AGENTS.md` files starting from a given directory and walking up through parent directories to the filesystem root.

#### Scenario: Single AGENTS.md in the working directory

- **WHEN** `discoverAgentsMdFiles` is called with a directory containing an `AGENTS.md` file
- **THEN** it SHALL return an array containing the absolute path to that file

#### Scenario: AGENTS.md in a parent directory

- **WHEN** `discoverAgentsMdFiles` is called with a directory that has no `AGENTS.md`, but an ancestor directory does
- **THEN** it SHALL return an array containing the absolute path to the ancestor's `AGENTS.md`

#### Scenario: Multiple AGENTS.md files at different hierarchy levels

- **WHEN** `discoverAgentsMdFiles` is called and `AGENTS.md` files exist at multiple levels (e.g., `/repo/AGENTS.md` and `/repo/packages/api/AGENTS.md`)
- **THEN** it SHALL return an array of absolute paths ordered from root-most to deepest (closest to the start directory)

#### Scenario: No AGENTS.md files found

- **WHEN** `discoverAgentsMdFiles` is called and no `AGENTS.md` file exists in the start directory or any ancestor
- **THEN** it SHALL return an empty array

#### Scenario: Default start directory

- **WHEN** `discoverAgentsMdFiles` is called without a start directory argument
- **THEN** it SHALL default to `process.cwd()` as the starting directory

#### Scenario: Custom start directory

- **WHEN** `discoverAgentsMdFiles` is called with an explicit start directory path
- **THEN** it SHALL begin the upward search from that directory instead of `process.cwd()`

#### Scenario: Walk stops at filesystem root

- **WHEN** `discoverAgentsMdFiles` walks upward through the directory hierarchy
- **THEN** it SHALL stop when the current directory equals its own parent (filesystem root reached)

### Requirement: Case-sensitive filename matching

The system SHALL match the filename `AGENTS.md` exactly (case-sensitive).

#### Scenario: Exact case match required

- **WHEN** a directory contains a file named `AGENTS.md`
- **THEN** `discoverAgentsMdFiles` SHALL include it in the results

#### Scenario: Different case is ignored

- **WHEN** a directory contains files named `agents.md`, `Agents.md`, or other case variants but not `AGENTS.md`
- **THEN** `discoverAgentsMdFiles` SHALL NOT include those files in the results

### Requirement: Synchronous file discovery

The system SHALL use synchronous filesystem APIs for AGENTS.md discovery.

#### Scenario: Discovery uses synchronous existence checks

- **WHEN** `discoverAgentsMdFiles` checks for `AGENTS.md` in each directory
- **THEN** it SHALL use synchronous filesystem APIs (e.g., `fs.existsSync`) to check file existence
