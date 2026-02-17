## Purpose

Enable the markdown streaming feature to integrate cleanly with the existing tool execution spinner feedback system by flushing accumulated streamed output before tool operation spinners begin.

## ADDED Requirements

### Requirement: Markdown stream flush before tool spinner

The system SHALL flush the active markdown stream before displaying tool execution spinners to prevent output conflicts between cursor-rewind rendering and spinner animation.

#### Scenario: Flush on tool start

- **WHEN** `onToolStart` is invoked during an active markdown streaming session
- **THEN** the markdown stream SHALL be flushed (current content committed, buffer reset) before the spinner starts

#### Scenario: Fresh markdown segment after tool completion

- **WHEN** tool execution completes and assistant text streaming resumes
- **THEN** new tokens SHALL push into a fresh markdown buffer
- **AND** cursor rewind SHALL NOT affect output rendered before the tool call

#### Scenario: No flush when markdown stream is inactive

- **WHEN** `onToolStart` is invoked and no markdown stream is active (e.g., JSON mode)
- **THEN** spinner behavior SHALL remain unchanged from existing behavior
