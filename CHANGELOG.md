# Changelog

All notable changes to Handoff Protocol are documented here.

## 3.0.0

**Breaking change — Context Map becomes a directory.**

The Context Map is now a compact semantic directory (`context-map.md`) plus
eight section body files under `.handoff/content/`, keyed by stable node IDs.
The single generated view moves to `.handoff/views/HANDOFF.md`. The v2
root-level `HANDOFF.md`, `tasks.md`, and `decisions.md` are retired.

### Added

- **Stable node IDs** (`goal1`, `task1`, `risk2`, …): immutable, never reused,
  preserved across renames and moves; high-water counters in
  `context.json.idCounters`.
- **Section content files** (`content/current-goal.md` … `content/excluded.md`)
  holding each node's summary + detail body.
- **Ownership-aware reconciliation** with independent directory and body
  ownership domains; agent inference never overwrites user edits and never
  infers a Current Goal from commits.
- **Effort-aware loading** — `/handoff load --effort min|low|med|high|max`
  (default `med`), per-load only, never persisted; explicit `--budget` degrades
  bodies → summaries → directory-only with reported steps.
- **Automatic atomic v2-to-v3 migration** on the first save: sensitive-filtered
  backups under `.handoff/history/migrations/`, temp-sibling writes, rename-phase
  rollback, idempotent, old root views retired.
- **Stable-ID semantic diff** — v3 diffs split changes into `added`, `deleted`,
  `moved`, `labelEdited`, `summaryEdited`, `bodyEdited`, `taskStateChanged`, and
  `attributesChanged`.
- **Viewer lazy node details** — the Viewer reads the directory first and loads
  each node body on demand via a token-scoped `GET /session/<token>/node/<id>`,
  cached per content version, rendered read-only with HTML escaped.
- Integrity diagnostics: `CONTENT_MISSING`, `CONTENT_DUPLICATE`,
  `CONTENT_ORPHAN`, `CONTENT_SUMMARY_MISSING`, `ID_INVALID`,
  `ID_COUNTER_RECOVERED`.
- Migration guide: `docs/migrations/v2-to-v3.md`.

### Changed

- Protocol schema and product version are both `3.0.0`.
- `context.json` carries `protocolVersion`, ID counters, and SHA-256 hashes of
  the directory, every content file, and the view (no semantic fields).
- Viewer daemon version is `3.0.0`.

### Migration

- v2 and legacy 1.x handoffs remain readable (load is read-only); the first
  `/handoff save` migrates automatically and atomically. See
  `docs/migrations/v2-to-v3.md`.
- **Do not** manually copy old root `tasks.md`/`decisions.md` into `content/`.

## 2.4.1

- Skills CLI (`npx skills add HughesCuit/handoff-protocol`) as the primary
  install path; agent compatibility tiers; assertion-based discovery check.

## 2.4.0

- Host-agnostic `/handoff view`: user-level Viewer daemon returning a
  token-scoped loopback URL; removed the Codex-only Context Map Viewer plugin.
