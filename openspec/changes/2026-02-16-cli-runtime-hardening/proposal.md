## Why

The CLI mixed interactive and non-interactive behavior, wrote output from multiple locations, and lacked first-class cancellation and JSON contracts. This made logs brittle and machine integration difficult.

## What Changes

- Add explicit runtime mode handling based on TTY/CI and CLI flags.
- Introduce a single terminal UI abstraction for status/log/progress output.
- Add `--help`, `--json`, `--plain`, and `--no-interactive` runtime flags.
- Route `SIGINT` into request cancellation with `AbortController` and exit code `130`.
- Ensure spinner and newline cleanup on all exit paths.

## Impact

- Better stability in CI and piped runs.
- Cleaner separation between UI output and machine-readable output.
- Reduced terminal corruption risk from mixed spinner/log writes.
