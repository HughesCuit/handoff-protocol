# Handoff Protocol v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Handoff Protocol from the released v1.5 Context Map into a canonical session-state protocol with selective context compilation, an Obsidian adapter, and semantic state diffs.

**Architecture:** Deliver the work as independently releasable versions. First harden v1.5, then make `context-map.md` the only writable semantic source, add a deterministic compiler behind `/handoff load`, connect project-local handoff data to a central Obsidian Vault without copying it, and finally add normalized snapshots and semantic diffs.

**Tech Stack:** Markdown, JavaScript ESM/Node.js, TypeScript/Deno, Node test runner, Deno test runner, Git-compatible filesystem operations.

## Global Constraints

- Keep the feature inside the existing `handoff` Skill.
- `.handoff/` remains the protocol data location and `context-map.md` remains human-editable Markdown.
- Preserve existing `init`, `storage`, `save`, and `load` behavior unless this plan explicitly extends it.
- Keep Node.js and Deno behavior equivalent through shared fixtures.
- Apply sensitive-data filtering before persistence, display, snapshotting, migration backup, or Adapter indexing.
- Do not add databases, embeddings, vector retrieval, Obsidian plugins, Canvas, or Dataview.
- Treat `.handoff.config.json` as portable project configuration; never write secrets, home paths, Vault paths, or machine-specific absolute paths into it.
- Use TDD for every behavior change and create a separate commit at each task boundary.

---

## Task 1: v1.5.1 TODO Scanner Hardening

**Files:**
- Create: `scripts/source-comments.mjs`
- Modify: `scripts/node/save.mjs`
- Modify: `scripts/save.ts`
- Test: `tests/shared/unit-suite.mjs`
- Test: `tests/node/context-map.test.mjs`
- Test: `tests/deno/context_map_test.ts`

**Interfaces:**
- Produce `extractTodoComments(source, extension): Array<{ tag, text, line }>` in the shared ESM module.
- Both runtimes must consume the same extraction behavior.

- [ ] Add fixtures containing real line/block comment TODOs and false positives inside ordinary strings, template literals, generated output text, and Markdown examples.
- [ ] Run Node and Deno scanner tests and confirm they fail because string contents are currently matched.
- [ ] Implement comment-aware extraction for supported source extensions.
- [ ] Exclude `.handoff`, test fixtures, generated/build directories, dependencies, and VCS metadata from repository scans.
- [ ] Preserve priority mapping: `FIXME` and `HACK` are high priority; `TODO` is medium priority.
- [ ] Run the focused scanner tests and then both complete suites.
- [ ] Commit as `fix: avoid false positive todo scans`.

## Task 2: v1.5.1 Configuration Policy and Validation

**Files:**
- Create: `scripts/config.mjs`
- Modify: `scripts/node/save.mjs`
- Modify: `scripts/save.ts`
- Test: shared Node/Deno configuration fixtures
- Modify: `README.md`, `SKILL.md`, and storage references

**Interfaces:**
- Produce `validateProjectConfig(config)` returning `{ valid, errors, config }`.
- Reject absolute paths and sensitive values outside `storage.remote`, whose existing submodule URL behavior remains supported.

- [ ] Add failing tests for home paths, Vault paths, credentials, malformed storage modes, and valid portable direct/submodule configurations.
- [ ] Implement shared configuration validation and call it before init, save, load, or Adapter operations.
- [ ] Document `.handoff.config.json` as safe and recommended to commit when validation passes.
- [ ] Add a real-project evaluation script or documented fixture runner that reports duplicate rate, user-edit retention, growth rate, and runtime parity without modifying source fixtures.
- [ ] Run Node/Deno suites and package dry-run.
- [ ] Set release markers to `1.5.1` only when the release commit is prepared.
- [ ] Commit as `release: harden handoff protocol 1.5.1`.

## Task 3: v2.0 Canonical State and Generated Views

**Files:**
- Create: `scripts/views.mjs`
- Modify: `scripts/context-map.mjs`
- Modify: runtime save/load entry points
- Test: shared canonical-state and view fixtures

**Interfaces:**
- `generateViews(map, metadata, options)` returns deterministic contents for `HANDOFF.md`, `tasks.md`, and `decisions.md`.
- Generated files begin with `<!-- generated-from: context-map.md; do not edit -->`.
- `context.json` v2 contains only:
  - protocol version, timestamp, Agent, project and language;
  - Git/environment state;
  - `views` entries containing SHA-256 values;
  - migration and conflict diagnostics.

- [ ] Add failing tests proving semantic fields are absent from v2 `context.json`.
- [ ] Add failing tests proving all compatibility views are reproducibly generated from the same Map.
- [ ] Implement deterministic view generators in shared ESM.
- [ ] Refactor save so inference reconciles only into `context-map.md`, followed by view generation.
- [ ] Store view hashes after successful writes.
- [ ] On load/save, compare current view hashes with metadata; warn on manual changes and never import those changes into the Map.
- [ ] Verify `compact`, `full`, `diff`, and all verbosity levels continue producing their documented compatibility files.
- [ ] Commit as `feat: make context map canonical`.

## Task 4: v2.0 Atomic Legacy Migration

**Files:**
- Create: `scripts/migrate.mjs`
- Modify: runtime save/load entry points
- Test: `tests/fixtures/handoffs/` migration matrix

**Interfaces:**
- `planMigration(inputs, userInstructions?)` is pure and returns the proposed Map, diagnostics, and source files.
- `applyMigration(plan, paths)` validates first, writes through temporary files, creates a backup, and renames atomically.

**Precedence:**

1. Explicit current user instructions and direct Context Map edits.
2. Structured legacy `context.json`.
3. Human-readable legacy files.
4. Repository or Agent inference.

- [ ] Add fixtures for legacy-only, Map-only, mixed, malformed, conflicting, partially missing, and already-migrated handoffs.
- [ ] Add failing tests proving migration preserves task state, decision rationale, risks, questions, and exclusions.
- [ ] Add failing tests proving conflicting lower-priority values remain visible below an “Migration conflict” node in Open Questions with source labels.
- [ ] Implement pure in-memory migration and validate the result with the production parser.
- [ ] Back up original files under `.handoff/history/migrations/<UTC-timestamp>/`.
- [ ] Atomically replace data only after all temporary outputs validate.
- [ ] Upgrade protocol/config version after the final rename succeeds.
- [ ] Prove injected write failure leaves original files and configuration unchanged.
- [ ] Prove repeated migration is idempotent.
- [ ] Commit as `feat: migrate legacy handoffs to v2`.

## Task 5: v2.1 Context Compiler

**Files:**
- Create: `scripts/context-compiler.mjs`
- Modify: runtime load entry points
- Test: shared compiler fixtures

**Public interface:**

```text
/handoff load [auto|merge] [--focus "current task"] [--budget N] [--full]
```

- `--budget` is an estimated token limit, defaults to `4000`, and rejects values below `512`.
- `--full` overrides focus and budget.
- When `--focus` is absent, the Skill passes the current user request; standalone CLI falls back to Current Goal plus active Tasks.

**Compiler contract:**

- Always include Current Goal, Current Status, incomplete Tasks, and high-severity Risks.
- Score other nodes by normalized keyword overlap across node text and ancestor paths.
- Include every ancestor of a selected node.
- Preserve original section and node order.
- Fall back to the full Map when no non-core node matches reliably.
- Never drop core nodes to satisfy the budget; report overflow instead.
- Return selected paths, omitted node count, estimated tokens, overflow, and fallback reason.

- [ ] Add failing tests for required core nodes, relevant nested branches, ancestor inclusion, deterministic ordering, overflow, no-match fallback, and `--full`.
- [ ] Implement the compiler as runtime-independent ESM without tokenizer dependencies.
- [ ] Use a documented deterministic estimate: CJK characters / 1.5 plus other characters / 4, rounded up.
- [ ] Extend Node and Deno CLI parsing and output diagnostics.
- [ ] Keep existing default/auto/merge behavior compatible when new flags are omitted.
- [ ] Run parity and legacy-load suites.
- [ ] Commit as `feat: compile focused handoff context`.

## Task 6: v2.2 Obsidian Adapter Core

**Files:**
- Create: `scripts/adapters/obsidian.mjs`
- Create: Node and Deno Adapter command entry points
- Test: cross-platform filesystem fixtures

**Public interface:**

```text
/handoff adapter obsidian link --vault <path> [--alias <name>]
/handoff adapter obsidian status
/handoff adapter obsidian unlink
```

**Configuration:**

```json
{
  "version": "2.2.0",
  "storage": {"mode": "direct", "path": ".handoff"},
  "adapters": {
    "obsidian": {
      "enabled": true,
      "projectAlias": "handoff-protocol"
    }
  }
}
```

- Store the Vault absolute path in `$XDG_CONFIG_HOME/handoff/config.json`, falling back to `~/.config/handoff/config.json` on macOS/Linux.
- Store it in `%APPDATA%/handoff/config.json` on Windows.
- Never copy the Vault path into project configuration.

- [ ] Add failing tests for path validation, Unicode/spaces, portable project config, idempotent links, aliases, collisions, broken links, and safe unlink.
- [ ] Implement `<Vault>/Projects/<alias>` pointing to the project `.handoff/`.
- [ ] Use directory symlinks on macOS/Linux and directory junctions on Windows.
- [ ] Treat an existing correct link as success.
- [ ] Refuse to replace real directories, files, or foreign links.
- [ ] Make unlink remove only a verified Adapter-created link and never its target.
- [ ] Return actionable permission guidance when the platform refuses link creation.
- [ ] Commit as `feat: add obsidian adapter`.

## Task 7: v2.2 Vault Index

**Files:**
- Modify: `scripts/adapters/obsidian.mjs`
- Test: Adapter index fixtures

**Interface:**
- Maintain only the block enclosed by:
  - `<!-- handoff-projects:start -->`
  - `<!-- handoff-projects:end -->`

- [ ] Add failing tests proving user-authored content outside the managed block survives link and unlink.
- [ ] Generate sorted wikilinks to each linked project’s `context-map.md`.
- [ ] Remove only the matching project entry during unlink.
- [ ] Apply sensitive-data filtering before writing the index.
- [ ] Confirm no Canvas or Dataview files are generated.
- [ ] Commit as `feat: index handoff projects in obsidian`.

## Task 8: v2.3 Semantic Snapshots

**Files:**
- Create: `scripts/snapshots.mjs`
- Modify: runtime save entry points
- Test: shared snapshot fixtures

**Snapshot contract:**

- Store normalized, sanitized JSON under `.handoff/history/snapshots/`.
- Write a snapshot only when semantic state changes.
- Retain the latest 20 snapshots by default.
- Snapshot IDs use UTC timestamp plus a short content digest.

- [ ] Add failing tests for first save, unchanged save, changed save, retention, stable normalization, and sensitive filtering.
- [ ] Implement normalization independent of localized section headings and generated fingerprints.
- [ ] Integrate snapshot creation only after a successful canonical save.
- [ ] Ensure cleanup never touches migration backups or non-snapshot files.
- [ ] Commit as `feat: snapshot semantic handoff state`.

## Task 9: v2.3 Context Diff

**Files:**
- Create: `scripts/context-diff.mjs`
- Create: Node and Deno diff command entry points
- Test: shared semantic-diff fixtures

**Public interface:**

```text
/handoff diff [--from latest|<snapshot-id>] [--format markdown|json]
```

**Diff contract:**

- Report added, removed, edited, moved, and task-state-changed nodes separately.
- Default comparison is the previous semantic snapshot against current state.
- JSON uses stable arrays containing section, path, before, after, and task state where relevant.
- Markdown renders the same model for human review.

- [ ] Add failing tests for each change class, mixed changes, no changes, invalid snapshot IDs, malformed snapshots, and both output formats.
- [ ] Implement stable node matching from normalized content, section, hierarchy, and task state without introducing persistent node IDs.
- [ ] Add Node/Deno command routing and error messages.
- [ ] Verify diff reads but never mutates snapshots or current state.
- [ ] Commit as `feat: add semantic context diff`.

## Task 10: Skill, Documentation, and Release Verification

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `references/` and examples
- Update: templates and package metadata

- [ ] Add executable behavior tests for every documented command before editing the Skill text.
- [ ] Update Skill instructions for canonical state, generated views, migration warnings, focused load, Adapter commands, and diff.
- [ ] Update configuration examples without absolute paths.
- [ ] Document Obsidian as an optional UI Adapter, not a storage authority.
- [ ] Document migration backup and recovery.
- [ ] Run:

```bash
npm test
deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
npm pack --dry-run --cache /private/tmp/handoff-npm-cache
git diff --check
```

- [ ] Confirm Node and Deno report zero failures and equivalent fixture results.
- [ ] Confirm the package contains no `.handoff/`, local config, Vault path, migration artifact, snapshot artifact, or secret.
- [ ] Release each version independently; do not combine v1.5.1, v2.0, v2.1, v2.2, and v2.3 into one release commit.

## Acceptance Summary

- Legacy 1.x and v1.5 projects remain readable and migrate without silent loss.
- Only `context-map.md` can author semantic state after v2 migration.
- Generated views are deterministic and tampering is visible.
- Focused load never omits core state and safely falls back to full context.
- Obsidian observes live project state without copying or owning it.
- Adapter unlink cannot delete user data.
- Snapshots are bounded, sanitized, and written only for semantic changes.
- Semantic diff output is deterministic across Node and Deno.
