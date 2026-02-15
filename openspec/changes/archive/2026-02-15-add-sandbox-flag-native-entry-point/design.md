## Context

Sandbox execution is currently exposed only through `bin/propio-sandbox`, while the native entrypoint in `src/index.ts` always starts the agent directly. The proposal and spec deltas require adding a `--sandbox` flag that delegates to the existing wrapper without changing Docker behavior, preserving native defaults, and keeping error/exit behavior consistent with direct wrapper invocation.

## Goals / Non-Goals

**Goals:**

- Add `--sandbox` handling in `src/index.ts` before native initialization.
- Delegate to `bin/propio-sandbox` from any caller CWD by resolving wrapper path relative to the runtime entrypoint file.
- Preserve all wrapper behavior (preflight checks, Docker usage, mounted workspace behavior, and error text).
- Propagate delegated process exit codes and surface spawn failures clearly.
- Keep native mode unchanged when `--sandbox` is not provided.

**Non-Goals:**

- Replacing or refactoring `bin/propio-sandbox`.
- Introducing new sandbox flags or aliases beyond `--sandbox`.
- Changing Docker image/build mechanics or sandbox filesystem policy.
- Adding persistent CLI configuration for sandbox preference.

## Decisions

### 1. Early argument gate in `src/index.ts`

`src/index.ts` will inspect `process.argv.slice(2)` before creating providers, tools, or readline UI. If `--sandbox` is present, execution short-circuits into delegation logic and returns/terminates after the child process completes.

This prevents partial native bootstrapping and ensures `--sandbox` is mode selection, not a runtime option layered on top of native startup.

### 2. Deterministic wrapper resolution from module location

Wrapper path resolution will be derived from the current module file path (ESM-safe), not from `process.cwd()`.

Implementation approach:

- Build `__filename` from `fileURLToPath(import.meta.url)`.
- Build `__dirname` via `path.dirname(__filename)`.
- Resolve repo root as `path.resolve(__dirname, "..")` (works for both `src/index.ts` and `dist/index.js` layouts).
- Resolve wrapper as `path.resolve(repoRoot, "bin", "propio-sandbox")`.

This keeps delegation reliable when users invoke `node /abs/path/to/dist/index.js --sandbox` from unrelated directories.

### 3. Delegation via `spawn` with inherited stdio

Delegation uses `child_process.spawn` with:

- `stdio: "inherit"` for transparent interactive behavior
- `shell: false` for predictable executable invocation
- `cwd` inherited from parent process to preserve workspace mapping semantics in the wrapper

Forwarded argv is original CLI args minus `--sandbox`, preserving order.

### 4. Exit and failure behavior mirrors wrapper outcome

The parent process exits with the delegated process exit code (or signal-derived non-zero fallback). If wrapper launch fails (missing/non-executable/OS error), print a clear error and exit non-zero.

This aligns native-entrypoint sandbox invocation with direct wrapper invocation expectations.

### 5. Documentation updates in `README.md`

Add native-entrypoint sandbox examples:

- `node dist/index.js --sandbox`
- `npm start -- --sandbox`

Clarify this mode still delegates to the Docker-based wrapper (`bin/propio-sandbox`), not a separate sandbox implementation.

## Risks / Trade-offs

- **Path assumption:** `path.resolve(__dirname, "..")` depends on existing `src/` and `dist/` layout. This is acceptable given current project structure and can be revisited if packaging layout changes.
- **Direct process exit handling:** Early mode-switch path introduces additional process-event handling complexity; mitigated with focused tests for exit/error propagation.
- **Wrapper as source of truth:** Delegation intentionally keeps wrapper logic centralized; native entrypoint remains a thin bridge instead of duplicating preflight behavior.

## Validation Plan

- Unit/integration test for `--sandbox` detection and argument forwarding (excluding `--sandbox`).
- Test that native startup path remains unchanged without `--sandbox`.
- Manual smoke:
  - `node dist/index.js --sandbox` from repo root.
  - `node /path/to/propio/dist/index.js --sandbox` from another directory.
  - Docker daemon stopped to confirm wrapper errors are preserved.
