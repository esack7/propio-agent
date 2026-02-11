## Why

The agent currently has only three tools: `read_file`, `write_file`, and `save_session_context`. This severely limits its ability to interact with the filesystem and execute tasks autonomously. Common operations like listing directories, creating folders, moving files, or searching codebases require tools the agent doesn't have. Adding filesystem navigation, search, and (opt-in) shell execution tools bridges this gap and makes the agent practically useful for real development workflows.

## What Changes

- Add `list_dir` tool: list directory contents at a given path
- Add `mkdir` tool: create directories (including intermediate parents)
- Add `remove` tool: delete files or directories at a given path
  - **Disabled by default** — must be explicitly enabled by the user due to recursive deletion risk
- Add `move` tool: move or rename a file/directory from one path to another
- Add `search_text` tool: search file contents by text query (with optional regex mode)
- Add `search_files` tool: find files matching a glob/pattern
- Add `run_bash` tool: execute arbitrary shell commands, returning stdout, stderr, and exit_code
  - **Disabled by default** — must be explicitly enabled by the user
  - Requires clear documentation of destructive potential before enabling
- Update the default tool factory to register all new tools

## Capabilities

### New Capabilities

- `filesystem-tools`: Directory listing, creation, removal, and move/rename operations
- `search-tools`: Text content search (with regex support) and file pattern/glob search
- `bash-execution`: Opt-in shell command execution with safety controls (disabled by default)

### Modified Capabilities

- `tools-module`: The default tool registry (factory) must register the new tools and disable `run_bash` by default

## Impact

- **Code**: New tool implementations in `src/tools/`, updated factory in `src/tools/factory.ts`
- **APIs**: Agent gains seven new tool schemas exposed to the LLM; `run_bash` introduces a new pattern of tools that are registered-but-disabled by default
- **Dependencies**: May add `glob` or `fast-glob` for pattern matching in `search_files`; `child_process` (Node built-in) for `run_bash`
- **Security**: `run_bash` is the primary risk surface — disabled-by-default pattern and explicit user opt-in mitigate this
