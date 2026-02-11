## Context

The agent has three tools today: `read_file`, `write_file`, and `save_session_context`. All tool implementations follow the `ExecutableTool` interface (`name`, `getSchema()`, `execute()`), live in `src/tools/`, and are wired up through a factory (`createDefaultToolRegistry`) that registers and enables them. The `ToolRegistry` already supports enable/disable semantics, but no tool currently ships disabled.

We need to add filesystem navigation (list, mkdir, remove, move), content/file search, and an opt-in bash execution tool. The existing patterns are simple and work — the design should extend them, not reinvent them.

## Goals / Non-Goals

**Goals:**

- Add seven new tools following the existing `ExecutableTool` pattern
- Organize tools into logical source files by capability group
- Use Node.js built-in modules (`fs`, `path`, `child_process`) wherever possible — avoid external dependencies
- Ship `run_bash` as registered-but-disabled, requiring explicit user opt-in via `agent.enableTool("run_bash")`
- Return structured, parseable output from all tools (especially `run_bash`)

**Non-Goals:**

- Sandboxing or permission systems beyond the disable/enable toggle — the Docker sandbox handles isolation
- Recursive directory listing — `list_dir` lists one level; the agent can call it multiple times
- Interactive or streaming bash — `run_bash` captures output after the process exits
- Changing the `ExecutableTool` interface or `ToolRegistry` API
- Adding confirmation prompts or user-facing UI for enabling tools — that's the caller's responsibility

## Decisions

### 1. File organization: one file per capability group

New tools will be organized as:

| File | Tools | Rationale |
|---|---|---|
| `src/tools/fileSystem.ts` | `read_file`, `write_file`, `list_dir`, `mkdir`, `remove`, `move` | These are all basic `fs` operations; grouping keeps imports tight |
| `src/tools/search.ts` | `search_text`, `search_files` | Both are search operations; `search_text` reads files, `search_files` uses glob matching |
| `src/tools/bash.ts` | `run_bash` | Isolated in its own file due to its distinct risk profile and `child_process` dependency |

**Alternative considered**: One file per tool. Rejected — the existing codebase groups `ReadFileTool` and `WriteFileTool` in one file, and the new filesystem tools share the same `fs` import. Separate files would add unnecessary module count without improving clarity.

### 2. Use `node:fs/promises` for new tools, `fast-glob` for search_files

The existing `read_file` and `write_file` use synchronous `fs` methods. New tools will use `fs/promises` (async) since `execute()` already returns a `Promise<string>`. The existing sync tools work fine and don't need to change.

For `search_files`, Node's built-in `fs.glob` (added in Node 22) is too new to depend on. `fast-glob` is a well-maintained, zero-native-dependency glob library. It's the only external dependency this change introduces.

**Alternative considered**: Implementing glob matching manually with recursive readdir + minimatch. Rejected — reimplementing glob is error-prone and `fast-glob` is battle-tested.

**Alternative considered**: Using Node built-in `fs.glob`. Rejected — requires Node 22+, and the project targets Node 20 (per Dockerfile).

### 3. `search_text` uses line-by-line string/regex matching, not `grep`

`search_text` will read target files and search line-by-line using JavaScript's `String.includes()` (literal mode) or `RegExp` (regex mode). This avoids shelling out to `grep`/`ripgrep`, keeping the tool self-contained and cross-platform.

Parameters: `query` (string), `paths` (string array of files/directories to search), `regex` (boolean, default `false`).

When a path is a directory, the tool will recursively find files in it (using `fast-glob`) before searching. Results are returned as formatted matches with file path, line number, and matching line content. Output is capped at a reasonable limit to avoid overwhelming the context.

**Alternative considered**: Shelling out to `grep -rn`. Rejected — introduces platform dependency and makes the tool depend on `run_bash` semantics.

### 4. `run_bash` uses `child_process.execFile` with `/bin/sh -c`

`run_bash` will use `child_process.execFile("/bin/sh", ["-c", command])` rather than `child_process.exec()`. Using `execFile` avoids an extra shell layer and gives more predictable behavior.

Parameters:
- `command` (string, required) — the shell command to execute
- `cwd` (string, optional) — working directory, defaults to `process.cwd()`
- `env` (object, optional) — additional environment variables, merged with `process.env`
- `timeout` (number, optional) — timeout in milliseconds, default 30000 (30s)

Returns a JSON string:
```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0
}
```

On timeout, the process is killed and the result includes whatever output was captured plus `exit_code: -1` and a timeout indicator in stderr.

Output is truncated if stdout or stderr exceed 50KB each, with a truncation notice appended.

### 5. Destructive tools disabled by default — factory calls `registry.disable()`

Both `run_bash` and `remove` are disabled after registration. The factory will register them like any other tool, then immediately call `registry.disable()` for each. This means:

- The tools are in the registry (visible via `getToolNames()`, `hasTool()`)
- They are NOT enabled (excluded from `getEnabledSchemas()`, `execute()` returns "Tool not available")
- Users enable them explicitly with `agent.enableTool("run_bash")` and/or `agent.enableTool("remove")`

No new API surface is needed — the existing `enable`/`disable` mechanism handles this. The pattern generalizes cleanly: any tool the factory considers high-risk gets registered then disabled.

### 6. `remove` handles both files and directories

`remove` will use `fs.rm(path, { recursive: true, force: true })`. This handles files, empty directories, and non-empty directories uniformly. The `force` flag prevents errors on non-existent paths.

The tool's schema description will clearly state that it removes files and directories recursively.

### 7. `mkdir` creates parent directories

`mkdir` will use `fs.mkdir(path, { recursive: true })`. This matches the common `mkdir -p` behavior and avoids errors when intermediate directories already exist.

## Risks / Trade-offs

**`run_bash` is inherently dangerous** → Mitigated by disabled-by-default. The agent running inside a Docker sandbox (per `docker-sandbox` spec) provides an additional isolation layer. The tool description sent to the LLM will include a warning about destructive potential.

**`search_text` on large directories could be slow** → Mitigated by output truncation and by requiring explicit path arguments (no default "search everything" behavior). For large-scale searches, users can enable `run_bash` and use `grep`/`ripgrep`.

**`fast-glob` is a new external dependency** → Acceptable trade-off. It has zero native dependencies, is widely used (500M+ weekly npm downloads), and avoids reimplementing glob matching.

**`remove` with `recursive: true` is destructive** → Mitigated by disabled-by-default, same as `run_bash`. Users must explicitly opt in with `agent.enableTool("remove")`. The Docker sandbox provides an additional isolation layer.
