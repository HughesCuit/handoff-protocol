# Handoff Protocol v3 Context Map Directory Design

## Summary

Handoff Protocol v3 changes the Context Map from a document that embeds all
semantic text into a lightweight directory. `context-map.md` owns node identity,
labels, hierarchy, and lightweight state; full node content lives in eight
section-specific Markdown files under `.handoff/content/`.

This is a breaking protocol-schema change. The product release and protocol
schema both become `3.0.0`. Existing v2 handoffs remain readable. The first
`/handoff save` performs an automatic, atomic v2-to-v3 migration with filtered
backups and rollback on pre-commit failure.

## Goals

- Keep the complete project structure visible in a compact Context Map.
- Load node bodies only when the current task or Viewer interaction needs them.
- Preserve Markdown-first, Git-friendly, human-editable storage.
- Support deterministic Node.js and Deno behavior without a database or vector
  index.
- Preserve user edits independently in the directory and body layers.
- Scale context loading across Agent context windows through per-load effort
  levels.
- Migrate v2 projects automatically without losing semantic content.

## Non-Goals

- No database, embeddings, vector search, or remote content service.
- No per-node file layout in v3.0.0.
- No UI editing in Context Map Viewer; it remains read-only.
- No project-persisted default effort level.
- No direct opening of browsers by `/handoff view`.
- No npm package publication solely for skill distribution.

## Storage Layout

```text
.handoff/
├── context-map.md
├── content/
│   ├── current-goal.md
│   ├── current-status.md
│   ├── tasks.md
│   ├── decisions.md
│   ├── open-questions.md
│   ├── risks.md
│   ├── knowledge-notes.md
│   └── excluded.md
├── views/
│   └── HANDOFF.md
├── context.json
└── history/
    ├── snapshots/
    └── migrations/
```

### Responsibility boundaries

`context-map.md` is the canonical directory. It owns:

- stable node ID;
- display label;
- parent-child hierarchy and document order;
- task checkbox state;
- compact visual metadata such as task priority and risk severity.

The files in `content/` are canonical node bodies. Each file owns the summary
and detailed narrative for nodes belonging to one semantic section.

`views/HANDOFF.md` is a deterministic generated view and must not be edited.
The v2 root-level `HANDOFF.md`, `tasks.md`, and `decisions.md` are not active v3
files.

`context.json` contains protocol and runtime metadata only: schema version,
timestamp, Agent, project, Git state, content/view hashes, node-ID counters,
and migration or integrity diagnostics. It does not contain semantic bodies.

`history/snapshots/` stores normalized, sanitized directory and body state for
semantic diff. `history/migrations/` stores sanitized backups of pre-migration
files.

## Directory Format

```markdown
# Context Map

## Current Goal

- goal1 Establish an extensible Agent context directory

## Tasks

- [ ] task1 Complete the v3 storage migration
  - [x] task2 Define node addressing

## Risks

- risk1 Migration may produce orphaned content
```

The fixed semantic sections remain Current Goal, Current Status, Tasks,
Decisions, Open Questions, Risks, Knowledge and Notes, and Excluded. Their
display headings remain localizable while their internal section keys remain
stable.

Node IDs use a short section-derived prefix and an increasing integer:

```text
goal1, status1, task1, decision1, question1, risk1, note1, excluded1
```

IDs are immutable and never reused. Renaming or moving a node does not change
its ID, even when the historical prefix no longer matches its new section.
Viewer hides IDs from normal labels.

`context.json.idCounters` stores the highest allocated number for each prefix.
If it is missing or damaged, recovery scans the directory, body files, and
snapshots and selects one greater than the highest observed value.

## Content Format

Each section file uses node IDs as level-two headings:

```markdown
# Tasks

## task1

Split embedded v2 Context Map semantics into section body files without losing
the original hierarchy or text.

Migration builds the complete v3 state in temporary siblings, verifies every
reference, and installs it atomically.

## task2

Use short, stable, monotonically increasing IDs for node addressing.
```

The first paragraph after an ID heading is a required, independently readable
summary. Remaining paragraphs are details. A body may be empty for a node that
exists only as a directory or grouping entry.

The node label exists only in `context-map.md`; body files do not duplicate it.
Task completion, priority, and risk severity also remain directory-owned.

## Reference Integrity

Every Map ID normally resolves to exactly one entry in the body file associated
with its current semantic section.

- A missing body does not make the directory unreadable. The node loads by
  label and emits `CONTENT_MISSING`.
- An ID appearing in more than one body file emits `CONTENT_DUPLICATE`; the
  loader does not guess which body wins.
- A body entry not referenced by the Map is an orphan. It is retained and
  reported rather than automatically deleted.
- Explicitly deleting both a node and its body is allowed only when the user
  requests complete deletion. Semantic snapshots retain historical evidence.

## Ownership and Reconciliation

Agent-created directory nodes and body entries carry hidden ownership markers
and fingerprints. The body fingerprint covers the complete entry, including
its required summary.

```markdown
- [ ] task1 Complete v3 migration <!-- agent --> <!-- agent-hash:... -->
```

```markdown
## task1 <!-- agent --> <!-- agent-hash:... -->

Migrate v2 projects atomically while preserving every semantic node.
```

Editing a directory node transfers ownership of its label, state, and position.
Editing a body transfers ownership of that body. These ownership domains are
independent: changing the label does not freeze the body, and editing the body
does not freeze the directory position.

Save updates existing IDs before creating new nodes, avoids semantic
duplicates, and never overwrites user-owned fields. It constructs and validates
the full replacement in temporary sibling files before installing it.

Current Goal may be empty. Git commit messages describe completed history and
must not be inferred as Current Goal. Only an explicit user goal or an existing
valid goal populates that section.

## Per-Load Effort

Effort controls context compilation, not persistence. Body files always retain
their complete canonical content. The setting is supplied on each load and is
never written to project configuration.

```text
/handoff load --effort min
/handoff load --focus "Viewer" --effort high
/handoff load --full --effort max
```

When omitted, effort defaults to `med`. The loader reports the effective effort
in its diagnostics.

| Effort | Loaded material |
|---|---|
| `min` | Context Map directory only; no bodies. |
| `low` | Directory plus first-paragraph summaries for selected nodes. |
| `med` | Complete bodies for selected nodes. |
| `high` | Complete bodies for selected nodes, their ancestors, and their direct subtrees. |
| `max` | Complete Map and all body entries. |

`--focus` selects relevant nodes. `--budget` remains the final hard token limit.
When selected material exceeds the budget, the compiler preserves the Map,
Current Goal, Current Status, active Tasks, and high-severity Risks first. It
then degrades full bodies to summaries before omitting lower-scored bodies and
reports every degradation and omission.

`--full` selects all nodes but does not silently defeat an explicitly supplied
budget. `--effort max` requests all bodies; the budget can still force reported
degradation. This avoids making a token-safety flag ineffective.

## Save and Load Data Flow

`/handoff save`:

1. Read and validate existing v3 directory, bodies, metadata, and ownership.
2. If v2 is detected, run the automatic migration described below.
3. Collect stable Agent/user updates and machine state.
4. Reconcile directory fields and body fields independently.
5. Allocate IDs only for genuinely new semantic nodes.
6. Build all changed files as temporary siblings.
7. Validate parsing, unique IDs, references, summaries, hashes, and counters.
8. Install atomically and write a snapshot only when semantic state changed.

`/handoff load`:

1. Read the directory and metadata.
2. Validate the ID index without eagerly loading every body into compiled
   context.
3. Select nodes using focus, effort, and budget.
4. Read only the body entries required by that selection.
5. Return compiled context plus selected paths, estimated tokens, integrity
   diagnostics, effort, and degradation reasons.

v2 remains read-only compatible. Load warns that the first later save will
migrate but performs no writes itself.

## Viewer Lazy Loading

Viewer initially reads only `context-map.md` and renders the complete directory.
Selecting a node calls a token-scoped read-only endpoint:

```text
GET /session/<session-token>/node/<id>
```

The response contains ID, current section, label, summary, complete Markdown
body, and a body version/hash. Viewer caches bodies within the session and
invalidates a cached value when the version changes.

Tree, Map, and Both modes use one shared selection and detail loader. Rapid
selection changes ignore or cancel stale responses. Missing bodies remain
visible as directory-only nodes with an integrity warning.

The server resolves IDs through a validated in-memory index and never converts
an untrusted ID into a file path. Markdown HTML is escaped and scripts are not
executed. Existing loopback binding, opaque session tokens, session expiry,
read-only behavior, and daemon lifecycle remain unchanged.

## Automatic v2-to-v3 Migration

Migration is triggered by the first `/handoff save` that detects schema 2.x.
`/handoff load` continues to read v2 without mutation and announces the pending
migration.

Migration precedence remains:

```text
explicit user instruction / direct v2 Map edit
  > v2 context.json when it contains legacy semantics
  > generated or legacy Markdown files
  > Agent inference
```

Migration steps:

1. Parse the v2 Context Map as the primary semantic source. Fall back only when
   it is absent or invalid.
2. Allocate IDs by semantic section and original document order.
3. Preserve hierarchy, task state, localized headings, and detected ownership.
4. Derive each directory label deterministically from the old node after
   removing Agent markers and fingerprints: take text through the first
   sentence/clause delimiter (`.`, `!`, `?`, `。`, `！`, `？`, `;`, `；`, or a
   line break), or all text when no delimiter exists. Limit the result to 60
   Unicode code points and append an ellipsis when truncated.
5. Write the complete original node text into its body entry. Each original
   child becomes its own directory node and body rather than being folded into
   its parent body.
6. Generate all v3 files in temporary siblings and validate that every original
   semantic text appears in the proposed state.
7. Create a sanitized backup at
   `.handoff/history/migrations/<UTC-timestamp>/`.
8. Install directory, bodies, view, snapshots, and metadata atomically. Update
   schema/config version to `3.0.0` last.
9. Roll back all replacements on any failure before commit. Cleanup after a
   successful commit is best-effort and cannot trigger destructive rollback.

Migration is idempotent. A v3 project is never assigned a second set of IDs.
The old root `HANDOFF.md`, `tasks.md`, and `decisions.md` are retired after
successful migration and remain available in the migration backup.

## Diagnostics

Stable diagnostics include:

- `CONTENT_MISSING`: Map ID has no body entry.
- `CONTENT_DUPLICATE`: one ID appears in multiple body files.
- `CONTENT_ORPHAN`: body entry has no Map node.
- `CONTENT_SUMMARY_MISSING`: a non-empty body has no first-paragraph summary.
- `ID_INVALID`: ID does not match the supported short-ID grammar.
- `ID_COUNTER_RECOVERED`: metadata counters were reconstructed from durable
  state.
- migration conflict and rollback diagnostics retained from v2.

Diagnostics are written to `context.json`, surfaced by save/load, and displayed
by Viewer when relevant. Sensitive-data filtering happens before persistence or
display.

## Snapshots and Diff

Snapshots normalize both directory state and body state. They preserve ID,
section, hierarchy, label, lightweight state, summary, and complete body after
sensitive-data filtering and removal of ownership fingerprints.

Diff continues to classify added, removed, edited, moved, and task-state
changes. In v3 it distinguishes label edits from body edits and reports section
moves by stable ID rather than content matching. Snapshot retention remains 20
non-duplicate semantic states.

## Release and Upgrade Documentation

The release is Handoff Protocol product `v3.0.0` with protocol schema `3.0.0`.
Skills CLI installation remains:

```bash
npx skills add HughesCuit/handoff-protocol
```

Release Notes must contain a dedicated “Migrating from v2” section explaining:

- why Context Map became a directory;
- the new `.handoff/content/` and `.handoff/views/` layout;
- per-load effort semantics;
- continued read-only v2 load support;
- automatic migration on the first save;
- backup location and rollback behavior;
- integrity diagnostic meanings and recovery guidance;
- that users and Agents must not manually copy old root `tasks.md` or
  `decisions.md` into `content/`.

The v3 `SKILL.md` must give Agents the same migration instructions and require
them to report migration outcome and diagnostics to the user.

## Testing

Node.js and Deno share the same fixtures and expected semantic models.

Core coverage includes:

- v3 directory/body parse, render, and round trips;
- ID allocation, immutability, non-reuse, renames, moves, and counter recovery;
- independent user ownership of directory and body fields;
- missing, duplicate, orphaned, invalid, and summary-less content;
- deterministic `min`, `low`, `med`, `high`, and `max` compilation;
- focus matching, budget degradation, and diagnostics;
- empty Current Goal and prohibition on commit-to-goal inference;
- Map-only, complete, mixed, localized, and user-edited v2 migrations;
- write, validation, backup, rename, rollback, and cleanup failure injection;
- repeat-migration idempotence and complete old-text preservation;
- Node/Deno behavioral parity.

Viewer coverage includes directory-only startup, lazy detail fetch, cache
invalidation, rapid selection, expiry, Markdown escaping, hostile IDs,
duplicate/missing bodies, oversized content, shared selection across all modes,
and existing folding/search/focus behavior.

Release gates are:

```text
npm test
npm run test:deno
npm run test:skills
npm pack --dry-run
git diff --check
```

Before release, migrate at least three real v2 projects and record node/body
counts, text preservation, integrity diagnostics, file/token changes, effort
load sizes, and Viewer startup/detail behavior.

## Deferred Work

- Optional per-node files for very large projects.
- Additional storage or knowledge-tool adapters.
- Editable Viewer.
- Semantic/vector retrieval.
- Cross-node relationship types beyond the directory hierarchy.
