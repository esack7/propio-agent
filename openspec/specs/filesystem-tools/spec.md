# Filesystem Tools Capability

## Purpose

Provides filesystem manipulation capabilities for the agent, including directory listing, creation, deletion, and file/directory movement operations.

## Requirements

### Requirement: list_dir tool lists directory contents
The system SHALL provide a `list_dir` tool that lists the contents of a directory at a given path. The tool MUST return a listing of entries with their type (file or directory) and name. The listing MUST be for the immediate children only (non-recursive).

#### Scenario: List a directory with files and subdirectories
- **WHEN** `list_dir` is called with a `path` pointing to a directory containing files and subdirectories
- **THEN** the system returns a listing of each entry with its type (`file` or `directory`) and name

#### Scenario: List an empty directory
- **WHEN** `list_dir` is called with a `path` pointing to an empty directory
- **THEN** the system returns an empty listing

#### Scenario: List a non-existent path
- **WHEN** `list_dir` is called with a `path` that does not exist
- **THEN** the tool throws an error indicating the path was not found

#### Scenario: List a path that is a file
- **WHEN** `list_dir` is called with a `path` pointing to a file instead of a directory
- **THEN** the tool throws an error indicating the path is not a directory

### Requirement: mkdir tool creates directories
The system SHALL provide a `mkdir` tool that creates a directory at a given path. The tool MUST create intermediate parent directories if they do not exist (recursive creation). The tool MUST NOT error if the directory already exists.

#### Scenario: Create a new directory
- **WHEN** `mkdir` is called with a `path` that does not yet exist
- **THEN** the system creates the directory and returns a success message

#### Scenario: Create nested directories
- **WHEN** `mkdir` is called with a `path` where intermediate parent directories do not exist
- **THEN** the system creates all intermediate directories and the target directory

#### Scenario: Create a directory that already exists
- **WHEN** `mkdir` is called with a `path` that already exists as a directory
- **THEN** the system returns a success message without error

### Requirement: remove tool deletes files and directories
The system SHALL provide a `remove` tool that deletes a file or directory at a given path. The tool MUST support recursive deletion for non-empty directories. The tool MUST NOT error if the path does not exist. The tool MUST be registered but disabled by default in the default tool factory.

#### Scenario: Remove a file
- **WHEN** `remove` is called with a `path` pointing to a file
- **THEN** the system deletes the file and returns a success message

#### Scenario: Remove an empty directory
- **WHEN** `remove` is called with a `path` pointing to an empty directory
- **THEN** the system deletes the directory and returns a success message

#### Scenario: Remove a non-empty directory
- **WHEN** `remove` is called with a `path` pointing to a directory containing files and subdirectories
- **THEN** the system recursively deletes all contents and the directory itself, returning a success message

#### Scenario: Remove a non-existent path
- **WHEN** `remove` is called with a `path` that does not exist
- **THEN** the system returns a success message without error

#### Scenario: remove is disabled by default
- **WHEN** the default tool registry is created via the factory
- **THEN** the `remove` tool is registered but disabled (`isToolEnabled("remove")` returns `false`)

### Requirement: move tool moves or renames files and directories
The system SHALL provide a `move` tool that moves or renames a file or directory from a source path to a destination path.

#### Scenario: Move a file to a new location
- **WHEN** `move` is called with a `path` pointing to a file and a `dest` that is a new file path
- **THEN** the system moves the file to the destination and returns a success message

#### Scenario: Rename a file
- **WHEN** `move` is called with a `path` and `dest` in the same directory but with different names
- **THEN** the system renames the file and returns a success message

#### Scenario: Move a directory
- **WHEN** `move` is called with a `path` pointing to a directory and a `dest` that is a new directory path
- **THEN** the system moves the entire directory tree to the destination

#### Scenario: Move to an existing path
- **WHEN** `move` is called with a `dest` that already exists as a file
- **THEN** the system overwrites the destination with the source

#### Scenario: Move a non-existent source
- **WHEN** `move` is called with a `path` that does not exist
- **THEN** the tool throws an error indicating the source was not found
