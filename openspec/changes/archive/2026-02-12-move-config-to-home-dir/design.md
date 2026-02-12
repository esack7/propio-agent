## Context

Currently, the application reads configuration from a project-local `.propio/providers.json` file. The path is hardcoded in `src/index.ts:22` and mounted into Docker via `bin/propio-sandbox:46`. This ties configuration to each project directory rather than to the user.

The change moves configuration to `~/.propio/providers.json` in the user's home directory, following Unix conventions (`.gitconfig`, `.bashrc`, `.ssh/`). This enables:

- Sharing configuration across all projects
- Separating user settings from project code
- Simplifying project setup (no need to copy config to each project)

The application runs in two modes:

1. **Native mode**: `npm start` runs directly on host with full filesystem access
2. **Sandbox mode**: `bin/propio-sandbox` runs in Docker with restricted filesystem access

Both modes need to access the same user configuration from `~/.propio/`.

## Goals / Non-Goals

**Goals:**

- Use `~/.propio/providers.json` as the single source of configuration for both native and sandbox modes
- Support cross-platform home directory resolution (macOS, Linux, Windows)
- Maintain Docker sandbox security model (read-only config mount)
- Provide clear error messages when config is missing or inaccessible
- Document migration path for existing users

**Non-Goals:**

- Auto-migration of existing `.propio/` directories (users must migrate manually)
- Supporting both old and new config locations simultaneously (clean break for simplicity)
- Config file auto-generation or interactive setup wizard (out of scope)
- Supporting per-project config overrides (future enhancement if needed)

## Decisions

### Decision 1: Use Node's `os.homedir()` for home directory resolution

**Choice**: Use Node.js built-in `os.homedir()` function

**Rationale**:

- Cross-platform: works on Unix (macOS/Linux) and Windows
- No external dependencies required
- Returns absolute path, avoiding shell expansion issues
- Well-tested and maintained by Node.js core team

**Alternatives considered**:

- Manual `~` expansion: Fragile, doesn't handle Windows `%USERPROFILE%`, requires custom logic
- Environment variable `$HOME`: Not portable to Windows, may be unset in some environments
- Third-party library (e.g., `os-homedir`): Unnecessary dependency for simple operation

### Decision 2: Create helper function `getConfigPath()` in configLoader.ts

**Choice**: Add new exported function `getConfigPath(): string` that returns the absolute path to `~/.propio/providers.json`

**Rationale**:

- Centralizes config path logic in one place
- Makes testing easier (can mock the function)
- Provides consistent behavior across native and sandbox modes
- Keeps `src/index.ts` clean (just call `getConfigPath()`)

**Implementation**:

```typescript
import * as os from "os";
import * as path from "path";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".propio", "providers.json");
}
```

**Alternatives considered**:

- Hardcode in `src/index.ts`: Duplicates logic if used elsewhere, harder to test
- Environment variable override: Adds complexity, not needed for MVP

### Decision 3: Update Docker sandbox to mount user's home `~/.propio/` directory

**Choice**: Modify `bin/propio-sandbox:46` to mount `~/.propio` from the host user's home directory into the container at `/app/.propio`

**Rationale**:

- Maintains existing container path (`/app/.propio`) so application code doesn't change between native/sandbox
- Keeps read-only mount (`:ro`) for security
- No changes needed to `docker-compose.yml` (volume specified dynamically in CLI wrapper)
- Works with bash `~` expansion in the wrapper script

**Implementation**:

```bash
# In bin/propio-sandbox:46
-v "$PROPIO_DIR/.propio:/app/.propio:ro"
# Becomes:
-v "$HOME/.propio:/app/.propio:ro"
```

**Alternatives considered**:

- Mount to `/root/.propio` in container: Requires changing container working directory logic, more complex
- Update docker-compose.yml: Less flexible, harder to override for testing
- Use Docker environment variable: Overcomplicates, volume mount is simpler

### Decision 4: Graceful error handling for missing config

**Choice**: Enhance error message in `loadProvidersConfig()` to guide users when config file doesn't exist

**Rationale**:

- Breaking change means existing users will hit "file not found" error
- First-time users also need guidance on where to put config
- Better UX than generic "ENOENT" error

**Implementation**:
Update the error message in `configLoader.ts:18` to:

```typescript
throw new Error(
  `Configuration file not found: ${filePath}\n` +
    `Please create ~/.propio/providers.json with your provider settings.\n` +
    `See README for configuration examples.`,
);
```

**Alternatives considered**:

- Auto-create `~/.propio/` directory: Might create unexpected files, users should explicitly set up
- Interactive config wizard: Out of scope, would require significant UI work
- Fallback to project-local `.propio/`: Defeats the purpose, creates confusion

### Decision 5: Keep backward compatibility flag as non-goal

**Choice**: Do NOT support reading from both old (`.propio/`) and new (`~/.propio/`) locations

**Rationale**:

- Clean break is simpler to implement and maintain
- Fallback logic adds code complexity and test burden
- Users can easily migrate (copy one file)
- Version bump makes breaking change explicit

**Alternatives considered**:

- Check old location as fallback: Complicates logic, delays inevitable migration
- Deprecation period with warning: Adds temporary code that must be removed later

## Risks / Trade-offs

### Risk: Users forget to create `~/.propio/` directory after upgrade

**Mitigation**:

- Update README with prominent migration instructions
- Enhanced error message guides users to create the file
- Consider adding a "Getting Started" section to documentation

### Risk: Docker sandbox fails if `~/.propio/` doesn't exist on host

**Mitigation**:

- Add check in `bin/propio-sandbox` script to verify `~/.propio/` exists before running Docker
- Print helpful error message with instructions if missing
- Example:
  ```bash
  if [ ! -d "$HOME/.propio" ]; then
    echo "Error: ~/.propio/ directory not found"
    echo "Please create it and add your providers.json configuration"
    exit 1
  fi
  ```

### Risk: Windows users may have different home directory behavior

**Mitigation**:

- `os.homedir()` handles Windows `%USERPROFILE%` correctly
- Test on Windows (if possible) or document known Windows behavior
- Windows users would use `C:\Users\<name>\.propio\providers.json`

### Trade-off: Lose per-project configuration flexibility

**Impact**: All projects share the same provider configuration
**Justification**:

- Original design intent is user-level settings (like API keys)
- If per-project config is needed later, can add override mechanism
- Most users likely use same LLM providers across projects

### Trade-off: Breaking change requires manual user action

**Impact**: Existing users must manually move config file
**Justification**:

- One-time cost for long-term benefit
- Simple migration (copy one file to new location)
- Clean architecture is worth the migration friction

## Migration Plan

### Pre-deployment

1. Update README with migration guide before releasing
2. Add notice to CHANGELOG documenting breaking change
3. Consider major version bump (if using semver)

### User migration steps

Users must perform these steps after upgrading:

```bash
# 1. Create the new config directory
mkdir -p ~/.propio

# 2. Copy the config file (if migrating from existing project)
cp /path/to/project/.propio/providers.json ~/.propio/providers.json

# 3. Verify the file is in place
ls -la ~/.propio/providers.json

# 4. (Optional) Remove old project-local config
rm -rf /path/to/project/.propio
```

### Rollback strategy

If users need to roll back:

1. Downgrade to previous version
2. Config file remains at `~/.propio/` (no harm)
3. Copy back to project-local `.propio/` if needed

### Testing migration

- Manual test: Move config to `~/.propio/`, run native mode, verify it works
- Manual test: Run sandbox mode, verify Docker mounts `~/.propio/` correctly
- Manual test: Delete `~/.propio/providers.json`, verify error message is helpful

## Open Questions

None. Design is straightforward with clear implementation path.
