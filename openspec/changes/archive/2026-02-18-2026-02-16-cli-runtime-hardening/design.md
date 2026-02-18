## Design Overview

The entrypoint computes a runtime profile from:

- terminal capability (`process.stdin.isTTY`, `process.stdout.isTTY`)
- CI status (`CI` env var)
- flags (`--json`, `--plain`, `--no-interactive`)

A `TerminalUi` class owns all terminal writes. It coordinates spinner lifecycle and stable line emission and exposes methods for status/info/warn/error/success/progress output.

## Execution Modes

1. Interactive mode:
- Uses readline prompt loop.
- Supports slash commands and tool menu.
- Uses spinner-backed tool status updates when enabled.

2. Non-interactive mode:
- Reads one request from stdin.
- Runs a single agent request.
- Emits either human-readable stderr output or JSON stdout output.

## Cancellation

- The CLI installs a process-level `SIGINT` handler.
- Active requests are cancelled via `AbortController`.
- The abort signal is passed through `Agent.streamChat` into provider request objects.
- OpenRouter fetch and Bedrock SDK calls receive the signal.

## Cleanup

The UI ensures spinner stop and trailing newline on exit paths (success, failure, interrupt).
