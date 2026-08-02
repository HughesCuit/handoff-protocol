# Migrating from v2 to v3

Handoff Protocol v3.0.0 changes the Context Map from a single document into a
**directory**. This guide explains what changed, how the automatic migration
works, and how to recover if something goes wrong.

## Why the Context Map became a directory

In v2, `context-map.md` embedded every node's full text. That kept the whole
project state in one file, but it forced every consumer (load, Viewer, diff)
to read and ship every body even when only the structure was needed, and long
bodies bloated the map.

v3 splits the canonical state into two layers:

- `context-map.md` — a compact **semantic directory**: stable node IDs, labels,
  hierarchy, task state, and compact metadata (task priority / risk severity).
- `content/*.md` — eight section files holding each node's **body** (a required
  first-paragraph summary plus verbatim detail), keyed by stable ID.

- `views/HANDOFF.md` — the only generated view, regenerated from the directory
  and bodies on every save (do not edit).

This keeps the complete project structure visible in a small directory while
bodies load only when a task or the Viewer actually needs them.

## The new layout

```
.handoff/
  context-map.md          # directory: IDs, labels, hierarchy, state
  content/
    current-goal.md       # bodies, keyed by stable ID
    current-status.md
    tasks.md
    decisions.md
    open-questions.md
    risks.md
    knowledge-notes.md
    excluded.md
  views/
    HANDOFF.md            # the only generated view (do not edit)
  context.json            # protocolVersion 3.0.0, ID counters, file hashes
  history/
    snapshots/
    migrations/           # sensitive-filtered backups of pre-migration originals
```

The v2 root-level `HANDOFF.md`, `tasks.md`, and `decisions.md` are retired.
They remain in the migration backup but are no longer read or written.

### Before / after

v2 `context-map.md`:

```markdown
## Tasks

- [ ] **high** Implement the storage migration. Validate every generated file before replacing any v2 file.
```

v3 `context-map.md` (directory) + `content/tasks.md` (body):

```markdown
## Tasks

- [ ] `task1` **high** Implement the storage migration
```

```markdown
# Tasks

## task1

Implement the storage migration. Validate every generated file before replacing any v2 file.
```

## Stable IDs

Every node gets a stable ID — a section prefix plus an increasing integer
(`goal1`, `task1`, `risk2`, …). IDs are:

- **Immutable:** renaming or moving a node keeps its ID; the body follows the
  node to its new section file.
- **Never reused:** deleting a node does not free its ID for a later node.
- **Recoverable:** `context.json.idCounters` stores the high-water mark per
  prefix; if it is missing or damaged, counters are reconstructed from durable
  state.

## How the automatic migration works

`/handoff load` stays **read-only** on old layouts: it reads v2 (and legacy
1.x) handoffs unchanged and prints a note that the next save migrates.

The first `/handoff save` migrates automatically and atomically:

1. The v2 Context Map is the primary semantic source (legacy 1.x sources chain
   through the v2 planner first). Precedence is
   `user/map > context.json > Markdown views > inference`.
2. Every node — including nested children — receives a stable ID by section and
   document order. The complete original node text becomes the body summary;
   the label is derived deterministically (text through the first clause
   delimiter, limited to 60 code points with an ellipsis when truncated).
3. All v3 files are built in temporary siblings and validated (every original
   semantic text must appear in the proposed state).
4. Originals — including `.handoff.config.json` — are backed up,
   sensitive-data filtered, under `.handoff/history/migrations/<UTC-timestamp>/`.
5. Temps are renamed into place; the config version upgrade (`3.0.0`) renames
   last. The old root views are retired.

### Rollback and idempotence

- If any rename fails before the commit point, every already-replaced file is
  restored from its pre-rename sibling, leaving the originals byte-identical.
  The migration can then be re-run safely.
- Cleanup after the commit point (dropping rollback siblings, retiring root
  views) is best-effort and can never trigger a destructive rollback.
- Migration is **idempotent**: an already-v3 handoff is never assigned a second
  set of IDs and creates no second backup.

## Per-load effort

`/handoff load` gains `--effort min|low|med|high|max` (default `med`). Effort
controls compilation only — it is chosen on every load, is never persisted, and
the `content/` files always retain their complete canonical content.

| Effort | Loaded material |
|---|---|
| `min` | Directory only; no bodies |
| `low` | Directory + first-paragraph summaries for selected nodes |
| `med` | Complete bodies for selected nodes |
| `high` | Complete bodies for selected nodes, their ancestors, and direct subtrees |
| `max` | Complete directory and all bodies |

An explicit `--budget N` is a hard token limit that can degrade higher efforts
(bodies → summaries → directory-only); every degradation is reported.

## Integrity diagnostics

Load and save surface stable diagnostics:

- `CONTENT_MISSING` — a directory ID has no body entry (the node still loads by
  label).
- `CONTENT_DUPLICATE` — one ID appears in multiple body files (not guessed).
- `CONTENT_ORPHAN` — a body entry has no directory node (retained, reported,
  never auto-deleted).
- `CONTENT_SUMMARY_MISSING` — a non-empty body has no first-paragraph summary.
- `ID_INVALID` — an ID does not match the short-ID grammar.
- `ID_COUNTER_RECOVERED` — ID counters were reconstructed from durable state.

## Important: do not hand-move old root files

Do **not** manually copy the old root `tasks.md` or `decisions.md` into
`content/`. Let the migration produce the content files — manual copies create
duplicate/orphan bodies and broken ID references.

## Recovery

- The pre-migration originals live in `.handoff/history/migrations/<UTC>/`.
  To roll back by hand, restore those files and reset `.handoff.config.json`
  `version` to `2.0.0`.
- If a migration is interrupted, re-run `/handoff save`; it is safe to repeat.
