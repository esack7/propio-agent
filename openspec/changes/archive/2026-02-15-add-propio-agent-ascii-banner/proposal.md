## Why

Users see no branding when the tool starts; adding a clear "Propio Agent" ASCII banner at startup improves recognition and gives the CLI a consistent identity.

## What Changes

- Display a fixed ASCII-art banner at the very start of the tool run, before any other CLI output.
- Banner shows "PROPIO" in block letters, then "A G E N T" on the next line, so the whole reads "Propio Agent".
- Banner is shown once per invocation from the main entrypoint.

## Capabilities

### New Capabilities

- `startup-banner`: Display a "Propio Agent" ASCII-art banner at CLI startup before other output.

### Modified Capabilities

- (none)

## Impact

- **Code**: Main entrypoint (e.g. `src/index.ts`) or a small UI/banner helper; possible reuse of existing CLI output helpers in `src/ui/`.
- **Tests**: Optional unit test for banner content or integration check that first output includes the banner.
- **Dependencies**: None.
