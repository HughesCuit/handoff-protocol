# Context Map Directory v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Release Handoff Protocol v3.0.0 with `context-map.md` as a compact semantic directory, section content stored in stable Markdown files, effort-aware loading, automatic v2 migration, and lazy Viewer node details.

**Architecture:** Introduce one canonical in-memory v3 state shared by Node and Deno. The Context Map owns stable IDs, labels, hierarchy, and semantic attributes; eight content files own summaries and bodies keyed by those IDs. Save, load, views, snapshots, diffs, and Viewer APIs must consume this shared state rather than parsing files independently.

**Tech Stack:** JavaScript ES modules, Node.js 22, Deno 2.x, Markdown, `node:test`, Deno test runner, built-in HTTP server, existing dependency-free Viewer frontend.

## Global Constraints

- Product version and protocol schema both become `3.0.0` only in the release preparation task.
- Preserve `init`, `save`, `load`, `storage`, `view`, `diff`, and adapter command compatibility unless this plan explicitly extends them.
- Keep Node and Deno behavior equivalent through the shared fixture suite.
- Do not introduce a database, vector search, a Markdown framework, or an Obsidian dependency.
- Do not make the Viewer editable in v3.0.0.
- Never turn Git commits, release state, or cleanup work into a Current Goal unless the user explicitly states that goal.
- Current Goal is allowed to be empty.
- Preserve user-authored content whenever migration or reconciliation can identify its stable node.
- Use atomic writes for every multi-file state transition and keep the original v2 state byte-for-byte recoverable until commit succeeds.
- Stop after creating a reviewed pull request. Merging, tagging, npm publishing, and GitHub Release creation require separate user authorization.

---

## Task 1: Define the canonical v3 directory and content model

**Files:**

- Create: `scripts/content-files.mjs`
- Create: `scripts/handoff-state.mjs`
- Create: `tests/fixtures/v3/basic/.handoff/context-map.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/current-goal.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/current-status.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/tasks.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/decisions.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/open-questions.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/risks.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/knowledge-notes.md`
- Create: `tests/fixtures/v3/basic/.handoff/content/excluded.md`
- Modify: `scripts/context-map.mjs`
- Modify: `tests/shared/unit-suite.mjs`

### Step 1: Add failing shared tests

Add tests that load the fixture and assert:

- exactly eight top-level sections are recognized;
- directory nodes contain only ID, label, hierarchy, task state, priority, or severity;
- content entries are addressed by stable node ID;
- the first paragraph is returned as `summary` and the remaining Markdown as `body`;
- an empty Current Goal section is valid;
- duplicate IDs, unknown IDs, missing required content files, and cross-section ID prefixes fail with actionable diagnostics.

Run:

```bash
npm test
npm run test:deno
```

Expected: both suites fail because the v3 state loader does not exist.

### Step 2: Implement the file registry

In `scripts/content-files.mjs`, export immutable registries:

```js
export const CONTENT_FILES = Object.freeze({
  goals: "current-goal.md",
  status: "current-status.md",
  tasks: "tasks.md",
  decisions: "decisions.md",
  questions: "open-questions.md",
  risks: "risks.md",
  notes: "knowledge-notes.md",
  excluded: "excluded.md",
});

export const ID_PREFIXES = Object.freeze({
  goals: "goal",
  status: "status",
  tasks: "task",
  decisions: "decision",
  questions: "question",
  risks: "risk",
  notes: "note",
  excluded: "excluded",
});
```

Also export section labels and deterministic section order.

### Step 3: Implement the canonical state loader

In `scripts/handoff-state.mjs`, export:

```js
export function parseContentFile(markdown, sectionKey) {}
export function renderContentFile(sectionKey, entries) {}
export function indexContextMap(map) {}
export function validateHandoffState(state) {}
export async function loadHandoffState(io, handoffDir) {}
```

Use a content-entry syntax that is human-readable and stable:

```markdown
## task1

Implement automatic v2 migration.

The migration must validate all generated files before replacing any v2 file.
```

Treat the first non-empty paragraph after the ID heading as the required summary. Preserve all following Markdown verbatim as the detail body.

### Step 4: Render and round-trip the v3 Context Map

Extend `scripts/context-map.mjs` with v3 parse/render support. A task node should render compactly, for example:

```markdown
- [ ] `task1` Automatic v2 migration
```

Non-task nodes should render:

```markdown
- `decision1` Context Map is the semantic directory
```

Ensure parse → render → parse preserves IDs, labels, hierarchy, task state, priority, severity, and section order.

### Step 5: Run tests and commit

Run the two shared suites again. Expected: green.

```bash
git add scripts/content-files.mjs scripts/handoff-state.mjs scripts/context-map.mjs tests/fixtures/v3 tests/shared/unit-suite.mjs
git commit -m "feat: define v3 handoff state model"
```

---

## Task 2: Add immutable short IDs and ownership-aware reconciliation

**Files:**

- Modify: `scripts/handoff-state.mjs`
- Modify: `scripts/context-map.mjs`
- Modify: `tests/shared/unit-suite.mjs`

### Step 1: Add failing tests

Cover:

- allocation begins at `task1`, `task2`, and equivalent section prefixes;
- deleted IDs are never reused;
- renaming or moving a node preserves its ID;
- changing a task state changes only the directory representation;
- changing a summary or body changes only the matching content entry;
- a user-edited label wins over an inferred replacement;
- a missing node is not recreated merely because its old body still exists;
- counters recover from both live nodes and historical metadata.

Expected: tests fail because allocation and reconciliation are absent.

### Step 2: Implement allocation and counter recovery

Export:

```js
export const NODE_ID_RE = /^(goal|status|task|decision|question|risk|note|excluded)([1-9][0-9]*)$/;
export function recoverIdCounters(state, metadata) {}
export function allocateNodeId(sectionKey, counters) {}
```

Store the highest allocated integer per prefix in `context.json`. Never decrement it and never fill holes.

### Step 3: Implement reconciliation

Export:

```js
export function reconcileV3State({ existing, inferred, userIntent }) {}
```

Apply ownership rules explicitly:

- Context Map: ID, label, parent, order, task state, priority, severity.
- Content file: summary and body.
- User edits override agent inference.
- Agent inference may update an existing stable node only when the current request or verified project evidence supports the change.
- Empty Current Goal remains empty unless the user states a goal.

Return structured diagnostics for orphan content, missing content, duplicate IDs, and rejected inferred changes.

### Step 4: Run tests and commit

```bash
npm test
npm run test:deno
git add scripts/handoff-state.mjs scripts/context-map.mjs tests/shared/unit-suite.mjs
git commit -m "feat: add stable context node identities"
```

---

## Task 3: Generate v3 views, metadata, and initial templates

**Files:**

- Create: `assets/content/current-goal.md`
- Create: `assets/content/current-status.md`
- Create: `assets/content/tasks.md`
- Create: `assets/content/decisions.md`
- Create: `assets/content/open-questions.md`
- Create: `assets/content/risks.md`
- Create: `assets/content/knowledge-notes.md`
- Create: `assets/content/excluded.md`
- Modify: `assets/context-map.template.md`
- Modify: `scripts/views.mjs`
- Modify: `scripts/save.ts`
- Modify: `scripts/node/save.mjs`
- Modify: `tests/shared/unit-suite.mjs`

### Step 1: Add failing tests

Assert that:

- `init` creates the Context Map, eight content files, `views/HANDOFF.md`, and v3 metadata;
- `HANDOFF.md` is a deterministic generated view and carries a prominent “edit Context Map/content files” notice;
- generated hashes include the Map, every content file, and `HANDOFF.md`;
- metadata includes `protocolVersion: "3.0.0"` and monotonic ID counters;
- no legacy root-level `tasks.md`, `decisions.md`, or `HANDOFF.md` is created in a fresh v3 directory.

### Step 2: Implement v3 templates

Keep all eight top-level sections in `assets/context-map.template.md`. Leave Current Goal empty in the initial template. Give content templates a brief format comment without fabricated project facts.

### Step 3: Implement deterministic views and metadata

In `scripts/views.mjs`, add:

```js
export function generateV3Views(state) {}
export function buildV3ContextJson({ state, project, git, environment, diagnostics }) {}
```

Generate `.handoff/views/HANDOFF.md` from the canonical state. Include every selected node label, summary, and body in stable section/node order. Hash normalized UTF-8 content with SHA-256.

### Step 4: Run tests and commit

```bash
npm test
npm run test:deno
git add assets scripts/views.mjs scripts/save.ts scripts/node/save.mjs tests/shared/unit-suite.mjs
git commit -m "feat: generate v3 handoff views"
```

---

## Task 4: Implement automatic atomic v2-to-v3 migration

**Files:**

- Create: `scripts/migrate-v3.mjs`
- Create: `tests/fixtures/migration/v2-complete/.handoff/context-map.md`
- Create: `tests/fixtures/migration/v2-complete/.handoff/HANDOFF.md`
- Create: `tests/fixtures/migration/v2-complete/.handoff/tasks.md`
- Create: `tests/fixtures/migration/v2-complete/.handoff/decisions.md`
- Create: `tests/fixtures/migration/v2-complete/.handoff/context.json`
- Modify: `scripts/migrate.mjs`
- Modify: `tests/shared/unit-suite.mjs`

### Step 1: Add failing migration tests

Cover:

- `load` detects v2 and reports that the next save will migrate without writing files;
- first `save` migrates automatically;
- all v2 semantic content maps to stable IDs and appropriate content files;
- conflicting sources follow `user/map > context.json > Markdown views > inference`;
- alternate values survive under Open Questions with source attribution;
- backup is written to `.handoff/history/migrations/<UTC timestamp>/`;
- repeated migration is idempotent;
- validation failure changes no original byte;
- failure before the final rename rolls back every installed file;
- cleanup failure after commit leaves a valid v3 state and only harmless rollback siblings.

### Step 2: Implement a pure migration planner

Export from `scripts/migrate-v3.mjs`:

```js
export function detectLayout(files) {}
export function planV2ToV3Migration(parsedLegacyState, options = {}) {}
export async function applyV3Migration(io, plan) {}
```

The plan must contain all target bytes, backup bytes, validation diagnostics, and rename operations before any write occurs.

### Step 3: Implement the transaction boundary

Use this order:

1. Parse every legacy source in memory.
2. Build and validate the complete v3 state.
3. Materialize all target files into unique temporary siblings.
4. Write the migration backup.
5. Rename existing targets to rollback siblings.
6. Rename every temporary file into place.
7. Mark the migration committed.
8. Remove rollback siblings as best-effort cleanup outside the transaction.

The catch path may restore rollback siblings only before step 7.

### Step 4: Run tests and commit

```bash
npm test
npm run test:deno
git add scripts/migrate-v3.mjs scripts/migrate.mjs tests/fixtures/migration tests/shared/unit-suite.mjs
git commit -m "feat: migrate v2 state to v3 atomically"
```

---

## Task 5: Integrate v3 state into save for Node and Deno

**Files:**

- Modify: `scripts/save.ts`
- Modify: `scripts/load.ts`
- Modify: `scripts/node/save.mjs`
- Modify: `scripts/node/load.mjs`
- Modify: `tests/deno/commands_test.ts`
- Modify: `tests/node/commands.test.mjs`

### Step 1: Add failing integration tests

Test fresh v3 save, repeated save, v2 auto-migration, user label/body preservation, task completion, node deletion, and empty Current Goal in both runtimes. Add a regression assertion that a release commit never becomes a Goal automatically.

### Step 2: Route save through canonical state

Make `save`:

1. detect layout;
2. migrate v2 if necessary;
3. load canonical v3 state;
4. gather verified project evidence;
5. reconcile without inventing goals;
6. allocate IDs only for genuinely new semantic nodes;
7. validate the full state;
8. atomically write Map, content, views, metadata, and snapshot.

Both runtimes must use the same pure planning functions and differ only in their I/O adapters.

### Step 3: Run parity tests and commit

```bash
npm test
npm run test:deno
git add scripts/save.ts scripts/load.ts scripts/node/save.mjs scripts/node/load.mjs tests/deno/commands_test.ts tests/node/commands.test.mjs
git commit -m "feat: save canonical v3 handoff state"
```

---

## Task 6: Add effort-aware Context Compiler and load behavior

**Files:**

- Modify: `scripts/context-compiler.mjs`
- Modify: `scripts/load.ts`
- Modify: `scripts/node/load.mjs`
- Modify: `SKILL.md`
- Modify: `tests/shared/unit-suite.mjs`
- Modify: `tests/deno/commands_test.ts`
- Modify: `tests/node/commands.test.mjs`

### Step 1: Add failing compiler tests

Cover every level:

- `min`: Context Map only.
- `low`: selected nodes plus summaries.
- `med`: selected nodes plus complete bodies.
- `high`: selected nodes, ancestors, and direct subtree with complete bodies.
- `max`: complete Map and all content bodies.

Also cover default `med`, invalid effort, focus matching by label/summary/body/path, ancestor preservation, deterministic order, explicit budget truncation, and metadata reporting.

### Step 2: Define the public interface

Support:

```text
/handoff load [auto|merge] [--focus "task"] [--effort min|low|med|high|max] [--budget N] [--full]
```

Export:

```js
export const EFFORT_LEVELS = Object.freeze(["min", "low", "med", "high", "max"]);
export function validateEffort(value) {}
export function compileContext({ state, focus, effort = "med", budget, full = false }) {}
```

### Step 3: Implement selection and budget rules

- Always preserve the directory entries required to understand selected content.
- `--full` selects all nodes but does not disable an explicitly supplied `--budget`.
- Without explicit budget, effort determines detail but has no hidden hard token cap.
- With explicit budget, progressively degrade body → summary → directory-only.
- Never split a Markdown paragraph mid-character.
- Report loaded IDs, omitted IDs/count, estimated tokens, effort, degradation steps, overflow, and fallback reason.
- A selected content entry must always retain its full ancestor path.

### Step 4: Update Skill semantics

Document that effort is chosen on every load, defaults to `med`, and is not persisted. Tell agents to use `min`/`low` for constrained context windows and `high`/`max` only when the task benefits from broad history.

### Step 5: Run tests and commit

```bash
npm test
npm run test:deno
git add scripts/context-compiler.mjs scripts/load.ts scripts/node/load.mjs SKILL.md tests/shared tests/deno/commands_test.ts tests/node/commands.test.mjs
git commit -m "feat: add effort-aware context loading"
```

---

## Task 7: Upgrade snapshots and semantic diff for stable IDs

**Files:**

- Modify: `scripts/snapshots.mjs`
- Modify: `scripts/context-diff.mjs`
- Modify: `scripts/diff.ts`
- Modify: `scripts/node/diff.mjs`
- Modify: `tests/shared/unit-suite.mjs`

### Step 1: Add failing tests

Assert detection of:

- node added/deleted;
- label edited;
- summary edited;
- body edited;
- node moved while retaining ID;
- task state changed;
- priority/severity changed;
- content-only changes create a snapshot;
- normalized no-op changes do not create a duplicate snapshot;
- sensitive values are filtered from Map and content bodies.

### Step 2: Normalize complete semantic state

Snapshot each node as stable fields:

```js
{
  id, section, parentId, order, label,
  taskState, priority, severity,
  summary, body
}
```

Hash the normalized array plus protocol version. Keep the existing retention limit of 20 snapshots.

### Step 3: Extend diff output

Return stable JSON categories `added`, `deleted`, `moved`, `labelEdited`, `summaryEdited`, `bodyEdited`, `taskStateChanged`, and `attributesChanged`. Render equivalent Markdown headings for human review.

### Step 4: Run tests and commit

```bash
npm test
npm run test:deno
git add scripts/snapshots.mjs scripts/context-diff.mjs scripts/diff.ts scripts/node/diff.mjs tests/shared/unit-suite.mjs
git commit -m "feat: diff v3 semantic state"
```

---

## Task 8: Add lazy Viewer node-detail API

**Files:**

- Create: `viewer/runtime/content-index.mjs`
- Modify: `viewer/runtime/context-store.mjs`
- Modify: `viewer/runtime/session-manager.mjs`
- Modify: `viewer/runtime/daemon-server.mjs`
- Modify: `viewer/runtime/daemon-state.mjs`
- Modify: `viewer/tests/context-store.test.mjs`
- Modify: `viewer/tests/session-manager.test.mjs`
- Modify: `viewer/tests/daemon-server.test.mjs`

### Step 1: Add failing runtime tests

Cover:

- `GET /session/<token>/node/task1` returns the matching label, summary, body, and version;
- unknown, malformed, encoded traversal, and wrong-section IDs return safe 404/400 responses;
- content files are parsed once per version and cached;
- file changes invalidate the index;
- a session cannot read another workspace;
- v2 layouts return a migration-required diagnostic instead of arbitrary root files.

### Step 2: Implement a safe content index

Export:

```js
export class ContentIndex {
  async refresh() {}
  get(nodeId) {}
  get version() {}
}
```

Build the index only from parsed Context Map IDs and the fixed content-file registry. Never concatenate request text into a filesystem path.

### Step 3: Add the endpoint

Add `GET /session/<token>/node/<id>` to `viewer/runtime/daemon-server.mjs`. Return JSON with `id`, `label`, `section`, `summary`, `body`, and `version`. Preserve token authorization and no-store headers used by existing session endpoints.

### Step 4: Run tests and commit

```bash
node --test viewer/tests/context-store.test.mjs viewer/tests/session-manager.test.mjs viewer/tests/daemon-server.test.mjs
git add viewer/runtime viewer/tests/context-store.test.mjs viewer/tests/session-manager.test.mjs viewer/tests/daemon-server.test.mjs
git commit -m "feat: serve lazy context node details"
```

---

## Task 9: Load Viewer details on demand

**Files:**

- Modify: `viewer/web/standalone.html`
- Modify: `viewer/web/app.mjs`
- Modify: `viewer/web/styles.css`
- Modify: `viewer/web/transports.mjs`
- Modify: `viewer/tests/transports.test.mjs`
- Modify: `viewer/tests/web-app-dom.test.mjs`
- Modify: `viewer/tests/web-model.test.mjs`
- Modify: `viewer/tests/web-view-state.test.mjs`

### Step 1: Add failing frontend tests

Test:

- opening a tree or map node requests `/node/<id>` only on first detail expansion;
- repeat opens use the versioned cache;
- a newer state version invalidates cached details;
- stale responses cannot overwrite the currently selected node;
- long Markdown renders in the detail panel without overflowing graph nodes;
- details remain read-only;
- menu navigation and map selection stay synchronized without recursive events.

### Step 2: Extend transport

Add:

```js
export async function loadNode(sessionBaseUrl, nodeId, signal) {}
```

Validate the returned ID and version before resolving.

### Step 3: Implement the detail panel

Keep graph labels compact. On explicit detail expansion, show label, summary, and safely rendered Markdown body in the existing side/detail area. Use `AbortController` or a request sequence number to reject stale responses.

### Step 4: Run tests and commit

```bash
node --test viewer/tests/transports.test.mjs viewer/tests/web-app-dom.test.mjs viewer/tests/web-model.test.mjs viewer/tests/web-view-state.test.mjs viewer/tests/daemon-server.test.mjs
git add viewer/web viewer/tests/transports.test.mjs viewer/tests/web-app-dom.test.mjs viewer/tests/web-model.test.mjs viewer/tests/web-view-state.test.mjs
git commit -m "feat: lazy load viewer node details"
```

---

## Task 10: Document migration and prepare v3.0.0

**Files:**

- Modify: `README.md`
- Modify: `SKILL.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `CHANGELOG.md`
- Create: `.handoff.config.example.json`
- Create: `docs/migrations/v2-to-v3.md`
- Create: `tests/node/docs.test.mjs`

### Step 1: Add failing documentation checks

Assert that package, lockfile, and Skill versions agree; protocol examples use `3.0.0`; all eight content files are documented; effort levels and migration behavior appear in README and Skill; and obsolete v2 root-file examples are absent from current-layout sections.

### Step 2: Write the migration guide

Document:

- how agents identify v1/v2 versus v3;
- why `load` is read-only on old layouts;
- how first `save` performs migration;
- where backups live;
- conflict precedence;
- how to recover after a failed migration;
- how stable IDs and content files relate;
- why Current Goal may be empty;
- that `effort` is per load and not saved.

Include a concrete before/after directory tree and a small content example.

### Step 3: Prepare versions and release notes

Set product and protocol schema to `3.0.0` in all declared version locations, including Viewer daemon compatibility. In the changelog, call out the breaking storage-layout change and automatic migration path.

### Step 4: Run tests and commit

```bash
npm test
npm run test:deno
npm run test:skills
git diff --check
git add README.md SKILL.md package.json package-lock.json CHANGELOG.md .handoff.config.example.json docs/migrations tests/node/docs.test.mjs viewer/runtime/daemon-state.mjs
git commit -m "release: prepare 3.0.0"
```

---

## Task 11: Validate migration against real project histories

**Files:**

- Create: `scripts/evaluate-v3-migration.mjs`
- Create: `docs/validation/v3-migration-report.md`
- Modify: `package.json`
- Modify: `tests/evaluate-migration.test.mjs`

### Step 1: Add a failing evaluator test

Use temporary copied fixtures and assert the evaluator reports:

- duplicate-node rate;
- preserved-user-edit rate;
- orphan-content count;
- byte growth by file and total;
- Node/Deno normalized output equality;
- migration and repeated-save idempotence.

The evaluator must never modify its source project.

### Step 2: Implement the evaluator

Add an npm script:

```json
"evaluate:v3-migration": "node scripts/evaluate-v3-migration.mjs"
```

Accept explicit project paths or fixture paths, copy each to an isolated temporary directory, migrate there, and emit machine-readable JSON plus a Markdown summary.

### Step 3: Run on representative projects

Run at least:

- the committed v2 migration fixture;
- this repository's pre-v3 migration backup or a sanitized copy;
- one project with user-edited Context Map labels;
- one project with empty Current Goal.

Record exact commands, dates, inputs, metrics, and any accepted limitation in `docs/validation/v3-migration-report.md`. Do not include secrets or absolute user paths.

### Step 4: Run tests and commit

```bash
node --test tests/evaluate-migration.test.mjs
npm run evaluate:v3-migration
git add scripts/evaluate-v3-migration.mjs docs/validation/v3-migration-report.md package.json tests/evaluate-migration.test.mjs
git commit -m "test: validate v3 migration behavior"
```

---

## Task 12: Complete release-candidate verification and review

**Files:**

- Modify only if verification exposes defects.

### Step 1: Run the complete acceptance matrix

```bash
npm test
npm run test:deno
npm run test:skills
node --test viewer/tests/*.test.mjs
npm run evaluate:v3-migration
npm pack --dry-run
git diff --check
```

Expected: all tests pass, migration metrics meet documented thresholds, and the npm tarball contains Skill, scripts, templates, migration docs, and Viewer assets while excluding worktrees, plugin caches, and development-only artifacts.

### Step 2: Manually verify the user journey

In a disposable copy:

1. Open a v2 project and run `load`; verify no write occurs.
2. Run `save`; verify automatic migration and backup.
3. Run `load --effort min`, `low`, `med`, `high`, and `max`; compare detail levels.
4. Run `load --effort max --budget 512`; verify deterministic degradation is reported.
5. Run `view`; verify compact initial Map, synchronized tree navigation, and lazy long-node details.
6. Edit a label and body, save again, then run `diff`; verify separate label/body changes.
7. Delete a node, create a new node, and verify the deleted ID is not reused.

### Step 3: Request independent code review

Use `superpowers:requesting-code-review`. Give the reviewer the design document, this plan, base SHA, head SHA, and acceptance output. Resolve every Important issue with a regression test, then rerun the full matrix.

### Step 4: Create the pull request and stop

Push a `codex/` feature branch and create a ready-for-review PR. The PR body must include:

- v3 directory model;
- stable-ID ownership rules;
- effort semantics;
- migration and rollback behavior;
- Viewer lazy-detail behavior;
- compatibility and breaking-change notes;
- exact acceptance results.

Do not merge, tag `v3.0.0`, publish npm, or create a GitHub Release until the user explicitly authorizes those actions.
