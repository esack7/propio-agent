# Home Config Resolution

## Purpose

This capability defines how the system resolves and loads configuration files from the user's home directory (`~/.propio/providers.json`), ensuring consistent cross-platform behavior in both native and Docker sandbox modes.

## Requirements

### Requirement: Resolve configuration path from user home directory

The system SHALL provide a function to resolve the absolute path to the configuration file in the user's home directory at `~/.propio/providers.json`.

#### Scenario: Get config path in native mode

- **WHEN** the application calls `getConfigPath()` in native mode
- **THEN** it SHALL return the absolute path to `~/.propio/providers.json` using the current user's home directory

#### Scenario: Path is absolute not relative

- **WHEN** `getConfigPath()` returns a path
- **THEN** the path SHALL be absolute (e.g., `/Users/alice/.propio/providers.json`) not relative (e.g., `./.propio/providers.json`)

### Requirement: Cross-platform home directory resolution

The system SHALL resolve the user's home directory correctly on all supported platforms (Unix-like systems and Windows).

#### Scenario: Unix home directory (macOS/Linux)

- **WHEN** the application runs on macOS or Linux
- **THEN** `getConfigPath()` SHALL resolve the home directory using standard Unix paths (e.g., `/Users/alice/.propio/providers.json` or `/home/alice/.propio/providers.json`)

#### Scenario: Windows home directory

- **WHEN** the application runs on Windows
- **THEN** `getConfigPath()` SHALL resolve the home directory using Windows user profile path (e.g., `C:\Users\Alice\.propio\providers.json`)

#### Scenario: Use Node.js built-in home directory resolution

- **WHEN** resolving the home directory path
- **THEN** the system SHALL use Node.js `os.homedir()` function rather than environment variables or manual path construction

### Requirement: Configuration loading uses home directory path

The system SHALL use the home directory-based config path when loading configuration at application startup.

#### Scenario: Application startup loads from home directory

- **WHEN** the application starts in native mode
- **THEN** it SHALL load configuration from the path returned by `getConfigPath()` (i.e., `~/.propio/providers.json`)

#### Scenario: No fallback to project-local config

- **WHEN** the application attempts to load configuration
- **THEN** it SHALL NOT check for or attempt to load from a project-local `.propio/providers.json` file

### Requirement: Docker sandbox mounts home directory config

The system SHALL mount the user's home directory `~/.propio` into the Docker container when running in sandbox mode, making the config accessible at the same logical location.

#### Scenario: Sandbox mode mounts user home config

- **WHEN** the user runs the application in sandbox mode via `bin/propio-sandbox`
- **THEN** the script SHALL mount the host's `~/.propio` directory to `/app/.propio` in the container as read-only

#### Scenario: Config path resolves correctly in container

- **WHEN** the application runs inside the Docker container
- **THEN** `getConfigPath()` SHALL resolve to `/app/.propio/providers.json` (the mounted location)

#### Scenario: Config accessible in both modes

- **WHEN** comparing config access between native and sandbox modes
- **THEN** the same configuration file content SHALL be accessible in both modes

### Requirement: Verify home config directory exists before Docker run

The system SHALL verify that the `~/.propio` directory exists on the host before attempting to run the Docker container.

#### Scenario: Sandbox pre-flight check passes

- **WHEN** `~/.propio` directory exists on the host and user runs `bin/propio-sandbox`
- **THEN** the Docker container SHALL start successfully with the config mounted

#### Scenario: Sandbox pre-flight check fails with helpful message

- **WHEN** `~/.propio` directory does NOT exist on the host and user runs `bin/propio-sandbox`
- **THEN** the script SHALL exit with an error message indicating that `~/.propio` must be created and SHALL NOT attempt to start Docker

#### Scenario: Error message guides user setup

- **WHEN** the pre-flight check fails
- **THEN** the error message SHALL include instructions to create `~/.propio` and add the `providers.json` configuration file

### Requirement: Enhanced error message for missing config file

The system SHALL provide clear, actionable error messages when the configuration file is not found at the home directory location.

#### Scenario: Config file missing with helpful error

- **WHEN** `loadProvidersConfig()` is called and `~/.propio/providers.json` does not exist
- **THEN** the system SHALL throw an error message that includes the expected file path and instructions to create the configuration

#### Scenario: Error message mentions home directory location

- **WHEN** the configuration file is not found
- **THEN** the error message SHALL explicitly reference `~/.propio/providers.json` as the expected location

#### Scenario: Error message references documentation

- **WHEN** the configuration file is not found
- **THEN** the error message SHALL direct users to documentation (README) for configuration examples
