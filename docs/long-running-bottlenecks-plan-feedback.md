# Re-Review Feedback on Long-Running Bottlenecks Implementation Plan

This is feedback on the latest `docs/long-running-bottlenecks-plan.md` as an implementation plan for addressing `docs/long-running-bottlenecks.md`.

## Overall Assessment

The plan is now very close to implementation-ready. The previous blockers have been addressed: absolute artifact paths, retention, encoding ownership, artifact ID ownership, provider scope, no-progress rollout, and runtime config injection are all clear.

I would make one final cleanup around session identity versus snapshot file identity, then start splitting the work into phases.

## Findings

### 1. Do not conflate session ID with snapshot filename

The stable runtime `sessionId` plan solves the identity problem for artifacts and in-progress markers, but the current wording says `writeSnapshot()` should use this `sessionId` as the snapshot filename.

Today, multiple saves create distinct snapshot files. If the snapshot filename is just the runtime session ID, repeated `/session save` or `/exit` saves for the same agent could overwrite the previous snapshot or create duplicate index entries.

Recommendation:

- Add `sessionId` to snapshot metadata.
- Keep snapshot filenames unique, or use a hybrid filename such as `{sessionId}-{timestamp}.json`.
- Use `sessionId` for grouping artifacts/markers and for retention lookup, not as the sole snapshot file identity.

### 2. Make session ID persistence explicit

Artifact retention depends on finding saved snapshots whose metadata `sessionId` matches an artifact directory. The plan mentions import reading `sessionId` from metadata, but the concrete persistence changes should be explicit.

Recommendation: add implementation bullets for:

- `SessionMetadata.sessionId?: string`.
- Serialization of `sessionId` in exported sessions.
- Parse validation/backward compatibility when `sessionId` is absent.
- Restore/import behavior when a legacy snapshot has no `sessionId`.
- Index extraction if retention or UI needs to look up session IDs without parsing full snapshots repeatedly.

### 3. Clarify singular versus batch tool-result recording

Phase 3 refers to `ContextManager.recordToolResult(...)` singular, but the current API is batch-oriented `recordToolResults(...)`.

Recommendation:

- Either add a singular helper intentionally, or
- Extend the existing `ArtifactToolResult` / `recordToolResults(...)` input shape with optional external-storage metadata.

The batch extension is probably smaller because it preserves the current call structure.

## Bottom Line

After the session/snapshot identity wording is tightened, this plan looks solid enough to implement phase by phase.
