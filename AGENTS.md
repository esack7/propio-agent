# AGENTS.md

Instructions for coding agents working in this repository.

## Scope

- Applies to the entire repository rooted at this directory.
- More deeply nested `AGENTS.md` files (if added later) override this file for their subtree.

## Project Overview

- Language/runtime: TypeScript on Node.js (ESM, `module: NodeNext`).
- Core entrypoint: `src/index.ts`.
- Agent orchestration: `src/agent.ts`.
- Provider abstraction and implementations: `src/providers/`.
- Tooling system and built-in tools: `src/tools/`.
- CLI formatting and UX helpers: `src/ui/`.
- Specs and change records: `openspec/`.

## Working Agreement

- Keep changes focused and minimal; avoid unrelated refactors.
- Preserve existing architecture boundaries (`agent`, `providers`, `tools`, `ui`).
- Do not introduce breaking behavior silently; reflect behavior changes in tests.
- Prefer explicit, typed code; avoid `any` unless unavoidable.
- Keep imports ESM-compatible and include `.js` extensions in TypeScript import specifiers where required by existing style.

## File and Config Rules

- Do not commit secrets or tokens.
- Provider config is expected in `~/.propio/providers.json`; do not hardcode credentials in source.
- Do not edit generated output in `dist/` (build artifacts).
- Keep `session_context.txt` as runtime state, not a source of truth for code behavior.

## Testing and Validation

Run relevant checks after changes:

- `npm test` for unit/integration coverage.
- `npm run build` to verify TypeScript compilation.
- `npm run format:check` for formatting compliance when touching multiple files.

If a check is skipped, state that clearly in your final summary.

## Specs and Change Management

- This repo is spec-driven (`openspec/config.yaml`).
- For behavior changes (new capability, changed contracts, or user-visible behavior), update the relevant spec(s) under `openspec/specs/` and add/archive change artifacts under `openspec/changes/` as appropriate.
- Pure refactors with no behavior change usually only require tests and code updates.

## Practical Conventions

- Prefer small, composable functions over large monolithic logic.
- Reuse existing factories/registries instead of adding one-off wiring.
- Keep CLI output concise and consistent with existing format helpers in `src/ui/`.
- When adding tools or providers, include tests in the corresponding `__tests__` directories.
