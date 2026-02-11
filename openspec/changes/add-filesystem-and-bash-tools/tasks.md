## 1. Dependencies

- [x] 1.1 Install `fast-glob` as a production dependency and `@types/node` already covers `fs/promises` and `child_process`

## 2. Filesystem Tools

- [x] 2.1 Implement `ListDirTool` in `src/tools/fileSystem.ts` — uses `fs/promises.readdir` with `withFileTypes`, returns entries with type and name
- [x] 2.2 Implement `MkdirTool` in `src/tools/fileSystem.ts` — uses `fs/promises.mkdir` with `{ recursive: true }`
- [x] 2.3 Implement `RemoveTool` in `src/tools/fileSystem.ts` — uses `fs/promises.rm` with `{ recursive: true, force: true }`
- [x] 2.4 Implement `MoveTool` in `src/tools/fileSystem.ts` — uses `fs/promises.rename` with `path` and `dest` parameters
- [x] 2.5 Write unit tests for `ListDirTool`, `MkdirTool`, `RemoveTool`, and `MoveTool` in `src/tools/__tests__/`

## 3. Search Tools

- [x] 3.1 Create `src/tools/search.ts` with `SearchTextTool` — accepts `query`, `paths`, `regex` (default false); line-by-line matching with `String.includes` or `RegExp`; recursive file discovery via `fast-glob` for directory paths; output truncation
- [x] 3.2 Implement `SearchFilesTool` in `src/tools/search.ts` — accepts `pattern` (glob string); uses `fast-glob` to find matching files; returns file path list
- [x] 3.3 Write unit tests for `SearchTextTool` and `SearchFilesTool` in `src/tools/__tests__/`

## 4. Bash Execution Tool

- [x] 4.1 Create `src/tools/bash.ts` with `RunBashTool` — uses `child_process.execFile("/bin/sh", ["-c", command])`; accepts `command`, `cwd`, `env`, `timeout` (default 30000ms); returns JSON `{ stdout, stderr, exit_code }`; handles timeout (exit_code -1), output truncation (50KB per field), and non-zero exit codes without throwing
- [x] 4.2 Write unit tests for `RunBashTool` in `src/tools/__tests__/` — cover successful execution, non-zero exit, timeout, and output truncation

## 5. Factory and Integration

- [x] 5.1 Update `createDefaultToolRegistry` in `src/tools/factory.ts` to register all seven new tools and disable `remove` and `run_bash` after registration
- [x] 5.2 Export new tool classes from `src/tools/` module index (if one exists) or ensure imports work from factory
- [x] 5.3 Write integration tests for the updated factory — verify all 10 tools are registered, 8 are enabled, `remove` and `run_bash` are disabled
