## Why

The application currently reads settings from a project-local `.propio/providers.json` file. This ties configuration to a specific codebase rather than the user, making it difficult to share settings across projects or maintain user-specific preferences. Moving to a home directory-based configuration (`~/.propio/`) follows standard Unix conventions (like `.bashrc`, `.gitconfig`) and enables user-specific, project-independent settings.

## What Changes

- Change config file location from `.propio/providers.json` (project-local) to `~/.propio/providers.json` (user home directory)
- Add home directory resolution logic that works cross-platform (Unix `~` expansion and Windows `%USERPROFILE%`)
- Update main entry point (`src/index.ts:22`) to resolve config path from home directory
- Update Docker sandbox volume mount (`bin/propio-sandbox:46`) to mount `~/.propio` instead of `$PROPIO_DIR/.propio`
- Update docker-compose.yml volume configuration to use home directory path
- **BREAKING**: Existing users will need to move their `.propio/providers.json` to `~/.propio/providers.json` after upgrading

## Capabilities

### New Capabilities

- `home-config-resolution`: Resolve configuration file paths relative to the user's home directory with cross-platform support

### Modified Capabilities

- None (the `json-config-loading` spec requirements remain unchanged - we still load and validate JSON the same way, just from a different path)

## Impact

- `src/index.ts`: Update hardcoded config path from relative project path to home directory resolution
- `src/providers/configLoader.ts`: May add home directory resolution helper function or use Node's `os.homedir()`
- `bin/propio-sandbox`: Update Docker volume mount to use `~/.propio` instead of `$PROPIO_DIR/.propio`
- `docker-compose.yml`: May need to update volume configuration (or keep dynamic via CLI wrapper)
- `openspec/specs/docker-sandbox/spec.md`: Configuration file access requirement remains valid but now targets user's home directory
- Test files: Update any tests that reference the `.propio` path to use the new home directory location
- Documentation: Update README to reflect new config file location and migration steps
- User migration: Breaking change requires users to manually move their config file to new location and ensure `~/.propio/` exists before running
