## ADDED Requirements

### Requirement: /tools command opens the tool menu

The system SHALL recognize `/tools` as a slash command in the TUI main loop. When the user enters `/tools`, the system MUST display the tool menu and suspend the normal chat prompt until the user exits the menu.

#### Scenario: User enters /tools command

- **WHEN** the user types `/tools` at the main prompt
- **THEN** the system displays the tool menu showing all registered tools with their status

#### Scenario: User returns to chat after exiting menu

- **WHEN** the user exits the tool menu (by typing `q` or pressing Enter with empty input)
- **THEN** the system returns to the normal chat prompt

### Requirement: Tool menu displays all registered tools with status

The system SHALL display a numbered list of all registered tools, each showing its name and current enabled/disabled status. The list MUST preserve tool registration order. Enabled tools MUST be labeled `[enabled]` and disabled tools MUST be labeled `[disabled]`.

#### Scenario: Display tools with mixed status

- **WHEN** the tool menu is displayed and the registry contains both enabled and disabled tools
- **THEN** the system shows a numbered list where each entry contains the tool name and its `[enabled]` or `[disabled]` status

#### Scenario: All tools enabled

- **WHEN** the tool menu is displayed and all registered tools are enabled
- **THEN** every entry in the list shows `[enabled]`

#### Scenario: All tools disabled

- **WHEN** the tool menu is displayed and all registered tools are disabled
- **THEN** every entry in the list shows `[disabled]`

### Requirement: User toggles a tool by entering its number

The system SHALL allow users to type a tool's number to toggle its enabled/disabled state. When a tool is currently enabled, toggling MUST disable it. When a tool is currently disabled, toggling MUST enable it. After a successful toggle, the system MUST re-display the updated tool list.

#### Scenario: Disable an enabled tool

- **WHEN** the user enters the number of an enabled tool
- **THEN** the system disables the tool, displays a confirmation message, and re-displays the tool list with the updated status

#### Scenario: Enable a disabled non-dangerous tool

- **WHEN** the user enters the number of a disabled tool that is not in the dangerous tools list
- **THEN** the system enables the tool, displays a confirmation message, and re-displays the tool list with the updated status

### Requirement: Dangerous tool confirmation warning

The system SHALL display a warning message and require explicit `y` confirmation before enabling a dangerous tool. The dangerous tools list MUST include `run_bash` and `remove`. If the user does not confirm with `y`, the tool MUST remain disabled.

#### Scenario: Enable dangerous tool with confirmation

- **WHEN** the user enters the number of a disabled dangerous tool (e.g., `run_bash`)
- **AND** the system displays a warning about the tool's destructive potential
- **AND** the user responds with `y`
- **THEN** the system enables the tool, displays a confirmation message, and re-displays the tool list

#### Scenario: Decline to enable dangerous tool

- **WHEN** the user enters the number of a disabled dangerous tool
- **AND** the system displays a warning
- **AND** the user responds with anything other than `y` (including `n`, empty input, or other text)
- **THEN** the tool remains disabled and the system re-displays the tool list

#### Scenario: Disabling a dangerous tool requires no confirmation

- **WHEN** the user enters the number of an enabled dangerous tool
- **THEN** the system disables the tool immediately without a warning prompt

### Requirement: Invalid menu input is handled gracefully

The system SHALL handle invalid input in the tool menu without crashing. Invalid input includes non-numeric text (other than `q`), numbers outside the valid range, and negative numbers.

#### Scenario: Non-numeric input

- **WHEN** the user enters non-numeric text that is not `q` in the tool menu
- **THEN** the system displays an error message and re-prompts

#### Scenario: Out-of-range number

- **WHEN** the user enters a number that does not correspond to any tool in the list
- **THEN** the system displays an error message and re-prompts

### Requirement: Agent exposes tool introspection methods

The `Agent` class SHALL expose `getToolNames()` and `isToolEnabled(name)` methods that delegate to the underlying `ToolRegistry`. These methods MUST return the same values as the corresponding `ToolRegistry` methods.

#### Scenario: getToolNames returns all registered tool names

- **WHEN** `agent.getToolNames()` is called
- **THEN** the system returns a `string[]` of all registered tool names (both enabled and disabled) in registration order

#### Scenario: isToolEnabled returns true for enabled tool

- **WHEN** `agent.isToolEnabled(name)` is called with the name of an enabled tool
- **THEN** the system returns `true`

#### Scenario: isToolEnabled returns false for disabled tool

- **WHEN** `agent.isToolEnabled(name)` is called with the name of a disabled tool
- **THEN** the system returns `false`

### Requirement: Startup help text includes /tools command

The TUI startup message SHALL list `/tools` alongside the existing commands (`/clear`, `/context`, `/exit`) so users know it is available.

#### Scenario: Help text shows /tools command

- **WHEN** the TUI starts up and displays the help text
- **THEN** the help text includes `/tools` as an available command
