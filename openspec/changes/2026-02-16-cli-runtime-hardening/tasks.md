## 1. CLI runtime flags and mode detection

- [x] 1.1 Parse `--help`, `--json`, `--plain`, and `--no-interactive`.
- [x] 1.2 Compute interactive/non-interactive behavior from TTY + CI + flags.

## 2. Centralized UI writer

- [x] 2.1 Add terminal UI abstraction with status/info/warn/error/success/progress APIs.
- [x] 2.2 Route menu/banner/entrypoint output through the UI abstraction.

## 3. JSON contract and stream separation

- [x] 3.1 Add one-shot stdin execution path for non-interactive and JSON mode.
- [x] 3.2 Ensure JSON mode writes only JSON payloads to stdout.

## 4. Cancellation and cleanup

- [x] 4.1 Add SIGINT handling and abort propagation to provider requests.
- [x] 4.2 Ensure spinner stop and trailing newline cleanup at exit.

## 5. Verification

- [x] 5.1 Update/add tests for args, UI writer behavior, and abort propagation.
- [x] 5.2 Run `npm test`, `npm run build`, and `npm run format:check`.
