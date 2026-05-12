# Re-Review Feedback on Long-Running Bottlenecks Implementation Plan

This is feedback on the latest `docs/long-running-bottlenecks-plan.md` as an implementation plan for addressing `docs/long-running-bottlenecks.md`.

## Overall Assessment

The plan is now quite close. The previous major issues have been addressed: no-progress rollout is consistent, provider scope matches the repository, runtime config injection is specified, and external artifact metadata is explicit.

Before implementation, I would make one more revision around session identity, artifact path resolution, retention semantics, and a couple of artifact schema ownership details.

## Findings

### 1. Add a stable runtime session ID

Phase 3 stores persisted tool outputs under:

```text
{sessionDir}/artifacts/{sessionId}/...
```

Phase 7 also uses `sessionId` for in-progress markers. Today, session IDs are generated only when `writeSnapshot()` creates a saved snapshot filename. There is no stable per-process or per-conversation session ID available at turn start.

Recommendation:

- Create a stable runtime session ID when the agent/session starts.
- Use that same ID for output persistence, in-progress markers, and eventual snapshot metadata.
- Document how this runtime session ID relates to the saved snapshot filename/session index entry.

Without this, artifact paths and crash markers do not have a reliable shared identity.

### 2. Make persisted artifact paths readable as described

The plan says `externalPath` is relative to the sessions directory, while storage is under `artifacts/{sessionId}/...`. The preview path example omits `artifacts/`. The `read` tool currently reads normal filesystem paths.

Recommendation: choose one clear path contract:

- Emit absolute filesystem paths in preview text so `read` can use them directly.
- Or teach `read` to resolve artifact-relative paths explicitly.

If using relative paths, include the full relative prefix, e.g. `artifacts/{sessionId}/bash-...log`, and document exactly what it is relative to.

### 3. Define retention semantics for external artifacts

Phase 3 adds 7-day artifact pruning. But session snapshots may contain `externalPath` references to those artifact files. If artifacts are pruned while snapshots remain, old sessions can import successfully but point to missing files.

Recommendation:

- Tie artifact retention to session retention, or
- Store enough state in the session index to prune artifacts only when no saved session references them, or
- Mark missing external artifacts clearly on import/read and document that old external artifacts are best-effort.

Do not silently leave imported sessions with broken artifact references.

### 4. Keep artifact encoding ownership clear

The proposed `ArtifactRecord` shape includes `contentEncoding`, but today `contentEncoding` is a persisted-session concern. The runtime `ArtifactRecord.content` is `string | Uint8Array` and has no encoding field.

Recommendation:

- Either keep `contentEncoding` persistence-only and do not add it to runtime `ArtifactRecord`, or
- Intentionally promote encoding into runtime state and update all runtime artifact code accordingly.

The smaller change is probably to keep encoding persistence-only.

### 5. Pick one owner for artifact IDs

The plan says `persistToolOutput()` returns `artifactId`, but the context manager currently generates artifact IDs when recording tool results.

Recommendation:

- Let `ContextManager` continue owning artifact ID generation, and have `persistToolOutput()` return only storage metadata, or
- Move artifact ID generation to the agent and pass IDs into the context manager explicitly.

The first option is smaller and preserves the existing ownership boundary.

## Bottom Line

The plan is nearly implementation-ready. One more pass on session ID, artifact path readability, artifact retention, encoding ownership, and artifact ID ownership should make it solid enough to split into phases and start coding.
