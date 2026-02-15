## Why

Sandbox mode currently depends on calling `bin/propio-sandbox` directly, which bypasses the native entry path and makes behavior less discoverable for users who start from `node dist/index.js` or `npm start`. Adding a first-class CLI flag improves usability while preserving the existing sandbox preflight checks and Docker execution model.

## What Changes

- Add a new CLI flag `--sandbox` in `src/index.ts`.
- When `--sandbox` is present, skip native agent startup and delegate execution to `bin/propio-sandbox`.
- Resolve the wrapper path from the runtime file location so it works from any current working directory.
- Forward arguments (excluding `--sandbox`) to the wrapper and exit with the same status code.
- Surface clear errors when the wrapper is missing or spawn fails.
- Update `README.md` with sandbox examples via the native entrypoint.

## Capabilities

### New Capabilities

- `sandbox-flag-native-entrypoint`: Start sandbox mode from the native CLI entrypoint by passing `--sandbox`, while reusing the canonical Docker wrapper.

### Modified Capabilities

- `docker-sandbox`: Expose existing sandbox behavior through the native entrypoint in addition to the wrapper script.

## Impact

- **Code**: `src/index.ts`, `README.md`
- **Specs**: Add or update delta specs under `openspec/changes/add-sandbox-flag-native-entry-point/specs/` for sandbox CLI behavior
- **Tests**: Add unit/integration coverage for `--sandbox` argument handling and wrapper delegation; run manual smoke checks for CWD behavior and Docker-not-running errors
- **Dependencies/ops**: No new dependencies; continues to require Docker for sandbox mode
