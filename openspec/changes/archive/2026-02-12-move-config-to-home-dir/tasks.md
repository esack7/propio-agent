## 1. Core Config Path Resolution

- [x] 1.1 Add `os` import to `src/providers/configLoader.ts`
- [x] 1.2 Implement `getConfigPath()` function that returns `path.join(os.homedir(), '.propio', 'providers.json')`
- [x] 1.3 Export `getConfigPath()` function from `src/providers/configLoader.ts`

## 2. Update Application Entry Point

- [x] 2.1 Update `src/index.ts:22` to import `getConfigPath` from configLoader
- [x] 2.2 Replace hardcoded config path with call to `getConfigPath()`
- [x] 2.3 Verify application starts and reads config from `~/.propio/providers.json` in native mode

## 3. Enhanced Error Messages

- [x] 3.1 Update error message in `configLoader.ts:18` to include helpful instructions for creating `~/.propio/providers.json`
- [x] 3.2 Update error message to reference README for configuration examples
- [x] 3.3 Test error message by running app without config file

## 4. Docker Sandbox Updates

- [x] 4.1 Add pre-flight check in `bin/propio-sandbox` to verify `~/.propio` directory exists (before Docker check)
- [x] 4.2 Add helpful error message if `~/.propio` doesn't exist, including instructions to create it
- [x] 4.3 Update volume mount in `bin/propio-sandbox:46` from `$PROPIO_DIR/.propio` to `$HOME/.propio`
- [x] 4.4 Keep `:ro` read-only flag on the volume mount
- [x] 4.5 Test sandbox mode starts successfully when `~/.propio` exists
- [x] 4.6 Test sandbox mode shows helpful error when `~/.propio` doesn't exist

## 5. Test Updates

- [x] 5.1 Update `src/providers/__tests__/configLoader.test.ts` to handle new `getConfigPath()` function
- [x] 5.2 Add test case for `getConfigPath()` returning absolute path
- [x] 5.3 Update any test fixtures that reference `.propio/providers.json` to use home directory
- [x] 5.4 Run test suite and verify all tests pass

## 6. Documentation Updates

- [x] 6.1 Add migration guide to README explaining how to move config from `.propio/` to `~/.propio/`
- [x] 6.2 Update README configuration section to reference `~/.propio/providers.json` as the config location
- [x] 6.3 Add note about cross-platform support (Unix `~` and Windows `%USERPROFILE%`)
- [x] 6.4 Document the breaking change and migration steps clearly
- [x] 6.5 Update any other documentation references to config file location

## 7. Manual Testing

- [x] 7.1 Create `~/.propio/` directory and copy test config
- [x] 7.2 Test native mode (`npm start`) loads config from home directory
- [x] 7.3 Test sandbox mode (`bin/propio-sandbox`) mounts and reads config from home directory
- [x] 7.4 Test error message when config file is missing
- [x] 7.5 Test error message when `~/.propio` directory doesn't exist (sandbox mode)
- [x] 7.6 Verify both modes access same config file content

## 8. Cleanup

- [x] 8.1 Remove project-local `.propio/` directory from repository (if present)
- [x] 8.2 Update `.gitignore` if needed to remove `.propio/` entry (no longer needed in projects)
- [x] 8.3 Consider adding CHANGELOG entry documenting breaking change
