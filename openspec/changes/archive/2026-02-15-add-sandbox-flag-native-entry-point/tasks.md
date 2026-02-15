## 1. CLI mode selection and delegation

- [x] 1.1 Update `src/index.ts` to detect `--sandbox` from CLI args before native initialization
- [x] 1.2 Implement early sandbox delegation path that bypasses native agent startup when `--sandbox` is present
- [x] 1.3 Forward all CLI arguments except `--sandbox` to the delegated wrapper process, preserving argument order

## 2. Wrapper path resolution and process execution

- [x] 2.1 Add ESM-safe module path resolution in `src/index.ts` using `fileURLToPath(import.meta.url)` and `path.dirname`
- [x] 2.2 Resolve wrapper path deterministically as `<repoRoot>/bin/propio-sandbox` based on entrypoint location, not current working directory
- [x] 2.3 Spawn wrapper with inherited stdio and inherited cwd so interactive behavior and workspace mounting remain unchanged
- [x] 2.4 Propagate delegated process exit code (or non-zero fallback on signal) to the caller

## 3. Error handling

- [x] 3.1 Handle missing/non-executable wrapper with clear user-facing error and non-zero exit
- [x] 3.2 Handle spawn/runtime execution failures by surfacing error details and exiting non-zero
- [x] 3.3 Ensure delegated Docker prerequisite errors are shown unchanged from wrapper output

## 4. Documentation

- [x] 4.1 Update `README.md` with native-entrypoint sandbox usage: `node dist/index.js --sandbox`
- [x] 4.2 Add `npm start -- --sandbox` example and clarify delegation to `bin/propio-sandbox`/Docker-based sandbox mode

## 5. Validation

- [x] 5.1 Add tests for `--sandbox` detection, argument forwarding (without `--sandbox`), and native path unchanged when flag is absent
- [x] 5.2 Manual smoke test from repo root: `node dist/index.js --sandbox`
- [x] 5.3 Manual smoke test from external directory: `node /path/to/propio/dist/index.js --sandbox`
- [x] 5.4 Manual negative test with Docker unavailable to verify wrapper error propagation
