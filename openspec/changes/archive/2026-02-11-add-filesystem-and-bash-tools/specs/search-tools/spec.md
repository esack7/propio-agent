## ADDED Requirements

### Requirement: search_text tool searches file contents

The system SHALL provide a `search_text` tool that searches for a text query within file contents. The tool MUST accept a `query` string, a `paths` array of file or directory paths to search, and an optional `regex` boolean (default `false`). When `regex` is `false`, the tool MUST perform literal string matching. When `regex` is `true`, the tool MUST treat the query as a regular expression. Results MUST include the file path, line number, and matching line content. Output MUST be truncated if it exceeds a reasonable size limit to avoid overwhelming context.

#### Scenario: Literal search finds matches in a file

- **WHEN** `search_text` is called with a `query`, `paths` containing a file path, and `regex` is `false`
- **THEN** the system returns all lines containing the literal query string, with file path, line number, and line content for each match

#### Scenario: Regex search finds matches

- **WHEN** `search_text` is called with a `query` containing a regular expression pattern, `paths` containing a file path, and `regex` is `true`
- **THEN** the system returns all lines matching the regex pattern, with file path, line number, and line content for each match

#### Scenario: Search a directory recursively

- **WHEN** `search_text` is called with a `paths` entry pointing to a directory
- **THEN** the system recursively finds files within that directory and searches each one

#### Scenario: No matches found

- **WHEN** `search_text` is called with a `query` that does not match any content in the specified `paths`
- **THEN** the system returns a message indicating no matches were found

#### Scenario: Invalid regex pattern

- **WHEN** `search_text` is called with `regex` set to `true` and an invalid regular expression in `query`
- **THEN** the tool throws an error indicating the regex pattern is invalid

#### Scenario: Output truncation on large results

- **WHEN** `search_text` produces results exceeding the size limit
- **THEN** the system truncates the output and appends a notice indicating truncation occurred

### Requirement: search_files tool finds files by glob pattern

The system SHALL provide a `search_files` tool that finds files matching a glob pattern. The tool MUST accept a `pattern` string (glob syntax). Results MUST be a list of matching file paths.

#### Scenario: Find files matching a glob pattern

- **WHEN** `search_files` is called with a `pattern` like `"src/**/*.ts"`
- **THEN** the system returns a list of file paths matching the glob pattern

#### Scenario: No files match the pattern

- **WHEN** `search_files` is called with a `pattern` that matches no files
- **THEN** the system returns a message indicating no files were found

#### Scenario: Pattern matches files in nested directories

- **WHEN** `search_files` is called with a recursive glob pattern like `"**/*.md"`
- **THEN** the system returns matching files from all nested subdirectory levels
