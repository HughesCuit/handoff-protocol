---
name: handoff
description: Cross-agent context handoff protocol. Save and restore work context across AI coding agents. Core workflow verified on Codex, Claude Code, OpenCode, and Kimi Code CLI; compatible with OpenHands and Cursor, and expected to work in other hosts that support basic skills. Use when switching between agents or collaborating with other AI assistants.
license: MIT
metadata:
  author: handoff-protocol
  version: "2.3.0"
---

# Handoff Protocol Skill

Cross-agent context handoff protocol. Save and restore work context across AI coding agents.

## Overview

The Handoff Protocol provides a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

When invoked, the skill manages a `.handoff/` directory that serves as the Agent Context Protocol - similar to `.git/` for version control, but for AI agent collaboration.

## Canonical State (v2)

Since v2, `.handoff/context-map.md` is the **only writable source of semantic state**. It is a human-editable Markdown tree that indexes the session state; it is generated or reconciled on every `/handoff save` (all modes and verbosity levels) and read first on every `/handoff load`.

The other handoff files are **deterministic generated views** of the map:

- `HANDOFF.md`, `tasks.md`, and `decisions.md` are regenerated from the map on every save. Each begins with the marker `<!-- generated-from: context-map.md; do not edit -->`.
- `context.json` (v2) carries no semantic fields — only protocol metadata, Git state, SHA-256 hashes of the generated views, and migration/conflict diagnostics.
- Loaders and savers compare on-disk view contents against the stored hashes. A manually edited view produces a warning naming the file; the edit is **never imported into the map** and is overwritten on the next save. To change semantic state, edit `context-map.md`.

**Semantic sections (fixed keys, localizable headings):**
- Current Goal
- Current Status
- Tasks
- Decisions
- Open Questions
- Risks
- Knowledge and Notes
- Excluded

Section headings may be localized (e.g. `--lang zh`); an internal label mapping resolves them back to the fixed semantic keys on parse.

**Node rules:**
- Each node (list item) is a concise, independently understandable statement.
- Nested list indentation expresses parent-child relationships and MUST be preserved when reading, reconciling, and writing the map.
- Prefer updating or moving an existing node over appending a semantic duplicate.
- Direct user edits always take priority over agent inference. Generated nodes include an `<!-- agent -->` marker and a hidden content fingerprint. If the text or task state changes without a matching fingerprint, the node automatically becomes user-owned and is never overwritten or removed. Removing the marker also takes ownership explicitly.
- Apply the sensitive-data filter before writing or displaying any Context Map content.

**Update the map only on stable state events**, not after every conversational turn:
- A goal or status change
- A task lifecycle change (added, started, completed)
- A stable decision or conclusion
- A new open question or risk
- A solution explicitly excluded
- An explicit user request to add, update, or remove a node

**Exclude from the map:** greetings, transient speculation, chain-of-thought, secrets, and details with no future value.

**Editing:** users edit the map by changing the Markdown directly or by asking in natural language (e.g. "add a risk about X", "mark task Y done"). No new slash command is introduced.

## Snapshots

Every save compares the map's semantic state against the latest snapshot under `.handoff/history/snapshots/` and writes a new snapshot **only when the semantic state changed**. Snapshots are sanitized (sensitive-data filter applied, generated fingerprints stripped) and bounded: the 20 most recent are kept, pruned oldest-first, and only files matching the snapshot naming pattern are ever pruned. Snapshots are the baseline for `/handoff diff`.

## Migration from Legacy 1.x / v1.5 Handoffs

Legacy handoffs remain readable forever — `load` handles them unchanged (read-only) and prints a note that migration is available. The next `/handoff save` migrates automatically and atomically:

1. **Precedence:** explicit user instructions and direct map edits win over structured `context.json`, which wins over the human-readable files (`tasks.md`, `decisions.md`, `HANDOFF.md`). Singleton fields (goal, status) get exactly one winner; superseded values are never dropped — they stay visible as child nodes under an Open Questions "Migration conflict" node, each labeled with its source file, and are mirrored into `diagnostics.conflicts`.
2. **Atomic write:** all outputs are written through temporary sibling files and validated; the originals (including `.handoff.config.json`) are backed up under `.handoff/history/migrations/<UTC-timestamp>/`; only then is each temp file renamed into place, with the config version upgrade renamed last.
3. **Backups are sensitive-data filtered.** If a legacy file contained credential-like content, its backup copy holds the filtered text, not the original bytes — do not rely on the backup to recover secrets.
4. **Rename-phase failures roll back.** If any rename fails mid-phase, every file already replaced is restored from its pre-rename sibling, leaving the original files byte-identical; the migration can then be re-run safely. The backup directory remains as an additional safety net.

Migration is idempotent: an already-migrated v2 handoff needs no migration and creates no second backup.

## Storage Modes

Handoff Protocol supports two storage modes for `.handoff/`:

### direct

Stores `.handoff/` directly in the current project directory.

Best for:
- Private repositories
- Local-only projects
- Personal projects
- Teams that intentionally version handoff context with the codebase

### submodule

Stores `.handoff/` as a Git submodule pointing to a separate private repository.

Best for:
- Public repositories
- Open-source projects
- Projects where handoff context should remain private
- Teams that want to separate source code history from agent context history

**For public repositories, submodule mode is recommended** because `.handoff/` may contain private context, implementation notes, local paths, task history, unfinished plans, architecture reasoning, or sensitive operational details.

## Commands

### /handoff init [mode]

Initialize handoff storage. If no mode is provided, prompts for selection.

**Modes:**
- `direct` - Store `.handoff/` directly in this project
- `submodule` - Store `.handoff/` as a Git submodule (requires private repo URL)

**Execution:**
1. Create `.handoff/` directory
2. Create `.handoff.config.json` with storage configuration
3. For submodule mode: `git submodule add <url> .handoff`
4. Prompt about `.gitignore` for direct mode

### /handoff storage

Display current storage mode and configuration.

Output:
```
Handoff storage:
  mode: submodule
  path: .handoff
  remote: git@github.com:USER/PROJECT-handoff.git
```

### /handoff save [mode] [--lang CODE] [--verbosity LEVEL]

Save current work context to `.handoff/`.

**Modes:**
- (default) - Standard save with current state
- `compact` - Minimal summary only
- `full` - Maximum context with all details
- `diff` - Focus on code changes

**Options:**
- `--lang CODE` - Language for generated handoff content (e.g. `zh`, `en`, `ja`, `ko`). If omitted, follows the language used in the current conversation session.
- `--verbosity LEVEL` - Detail level: `low`, `med`, `high`. Default: `med`.
  - `low` - Minimal output: goal, status, next steps only (similar to compact but respects lang)
  - `med` - Standard output: balanced detail with TODO scan, risk analysis
  - `high` - Maximum output: extended git history, full diff stats, all TODOs, detailed risk assessment

**Pre-checks:**
1. Read `.handoff.config.json` to determine storage mode
2. If not configured, trigger initialization flow
3. For submodule mode: verify submodule is initialized

**Execution:**
1. Run `git status`, `git diff --stat`, `git log --oneline -5`
2. Analyze current work state (TODO/FIXME comments, commit history, risk factors)
3. If a legacy 1.x / v1.5 handoff is detected, migrate it first (see Migration; originals are backed up under `.handoff/history/migrations/`)
4. Generate or reconcile `.handoff/context-map.md` (every mode and verbosity; preserves user edits, deduplicates semantic nodes)
5. Regenerate the deterministic views `HANDOFF.md`, `tasks.md`, `decisions.md` (skipped at `low` verbosity except `HANDOFF.md`) and `context.json` (metadata + view hashes)
6. Write a semantic snapshot under `.handoff/history/snapshots/` if the semantic state changed
7. For submodule mode: commit and push to submodule repo (including `context-map.md`)

### /handoff load [mode] [--focus TEXT] [--budget N] [--full]

Read and restore context from `.handoff/`.

**Modes:**
- (default) - Standard read and summarize
- `auto` - Auto-infer next steps
- `merge` - Merge with current context

**Options (context compiler):**
- `--focus TEXT` - Compile the map down to the nodes relevant to this text. Current Goal and Current Status (and their ancestors) are always kept; other nodes are selected by deterministic keyword-overlap scoring.
- `--budget N` - Estimated token limit for the compiled map. Default `4000`, minimum `512`; lower or non-numeric values are rejected.
- `--full` - Return the entire map; overrides `--focus` and `--budget`.

If no non-core node matches the focus reliably, the compiler safely falls back to the full map and reports the reason — focused load never omits core state. Without compiler flags the output carries no compiler diagnostics. Compilation is strictly read-only.

**Pre-checks:**
1. Read `.handoff.config.json` to determine storage mode
2. For submodule mode: verify submodule is initialized, run `git submodule update --init --recursive .handoff` if needed

**Execution:**
1. Read `.handoff/` contents
2. Read `context-map.md` first (the canonical semantic source); supplement with machine state from `context.json`
3. If the map is absent, empty, or malformed, fall back to `context.json`, then `HANDOFF.md` (legacy 1.x behavior, no migration needed). For a v2 handoff with a missing map, fall back to the `HANDOFF.md` view
4. Warn about manually edited generated views (hash mismatch); semantics still come from the map
5. Warn (read-only) when the handoff is a legacy pre-v2 format that `/handoff save` would migrate
6. Summarize current state
7. Generate recommended next actions

### /handoff adapter obsidian link --vault PATH [--alias NAME]

Link the project's `.handoff/` into an Obsidian Vault as `<Vault>/Projects/<alias>` (directory symlink on macOS/Linux, directory junction on Windows).

Obsidian is an **optional UI Adapter, not a storage authority**: it observes the live `.handoff/` directory through the link. Nothing is copied into the Vault except the link itself and a `Handoff Projects.md` index note; `.handoff/` remains the only place where handoff state is stored, and the Context Map remains the only semantic source.

**Execution:**
1. Validate the Vault path (must be absolute; spaces and Unicode are fine)
2. Create `<Vault>/Projects/` if needed, then the link
3. Store the Vault path in the **user-level** config only: `$XDG_CONFIG_HOME/handoff/config.json` (falling back to `~/.config/handoff/config.json` on macOS/Linux) or `%APPDATA%/handoff/config.json` on Windows — never in `.handoff.config.json`
4. Record portable adapter state in `.handoff.config.json`:
   ```json
   "adapters": { "obsidian": { "enabled": true, "projectAlias": "<alias>" } }
   ```
5. Maintain a sorted wikilink entry for the project inside the managed block of `<Vault>/Handoff Projects.md` (sensitive-data filtered; user content outside the managed block is preserved)

**Safety rules:**
- An existing link to this project's `.handoff/` is an idempotent success
- Real directories, files, or links pointing elsewhere are never replaced
- Permission failures return actionable guidance (macOS Full Disk Access; Windows Developer Mode or an elevated terminal)

### /handoff adapter obsidian status

Show the Vault path, alias, link path, and state (`linked`, `missing`, `broken`, `foreign-link`, `conflict`).

### /handoff adapter obsidian unlink

Remove only a verified Adapter-created link (a symlink/junction whose target is exactly this project's `.handoff/`) and its index entry. Never removes the link's target, real directories, files, foreign links, or user content in the Vault — unlink cannot delete user data.

### /handoff diff [--from latest|SNAPSHOT_ID] [--format markdown|json]

Compare a semantic snapshot against the current Context Map and report added, removed, edited, moved, and task-state-changed nodes as separate groups. The default comparison is the latest snapshot under `.handoff/history/snapshots/` against the current state; `--from <snapshot-id>` pins an older snapshot.

**Execution:**
1. Run `scripts/diff.ts` (Deno) or `scripts/node/diff.mjs` (Node.js) with the requested flags
2. Present the report; `--format json` emits stable arrays (`added`, `removed`, `edited`, `moved`, `taskStateChanged`) with `section`, `path`, `before`/`after`, and task state where relevant

**Safety rules:**
- Diff is strictly read-only: it never mutates snapshots, the Context Map, or any other file
- Comparison works on normalized semantic state, so localized headings and generated fingerprints never produce phantom changes; output is deterministic across Node and Deno
- Output is sensitive-data filtered before display

### /handoff view [--idle-minutes N] [--json]

Open the current project's `.handoff/context-map.md` as a live, read-only mind map. Starts or reuses one user-level local Viewer daemon and returns a temporary, token-scoped loopback URL for the current project. **The Agent, not the command, decides how to open that URL** — in a side browser, system browser, external browser, or simply presented to the user. The command never opens a browser itself and never requires an MCP App or plugin.

**Options:**
- `--idle-minutes N` - Idle expiry for the new Viewer session. Default `30`; accepted values are integers from `1` through `1440` inclusive.
- `--json` - Emit exactly one JSON object on stdout (`{status, url, sessionId, source, idleMinutes, daemonReused}`). Diagnostics go to stderr.

**Execution:**
1. Resolve the current project root exactly as `save` and `load` do
2. Run `scripts/node/view.mjs` (Node.js) with the requested flags
3. Present the returned URL to the user or open it with the Agent's native browser capability. Do not persist, reconstruct, or reuse the URL in another task.

**Node.js-only:** The Deno-facing `scripts/view.ts` recognizes `view` but returns the stable error `VIEW_REQUIRES_NODE` with an actionable Node command (`node scripts/node/view.mjs`). All other Handoff Deno commands are unchanged.

**Safety rules:**
- Loopback-only (`127.0.0.1`, random port), read-only, token-scoped, in-memory; no LAN, no auth-for-remote, no permanent daemon/service
- The daemon auto-shuts-down when no sessions remain; sessions expire after their own idle deadline
- The URL listens only on loopback at a random port and is scoped by an opaque token; do not copy, persist, or reuse it across tasks
- Never prints secrets, source contents, control tokens, or absolute project paths
- Does not change `.handoff/`, `context-map.md`, or the v2 schema

## Output Format

When loading, generate:

```
Current understanding:
[concise summary of project state]

Recommended next actions:
[actionable next steps]

Potential risks:
[known blockers or risks]
```

## Security

All saves automatically filter:
- API keys, tokens, secrets (generic, GitHub, GitLab, AWS)
- Bearer tokens, JWT tokens, cookies
- Passwords, private keys (PEM, SSH)
- Connection strings with credentials
- Cloud service credentials (GCP, Azure)
- OAuth tokens, OpenAI API keys

The filter applies before anything is persisted or displayed: handoff files, the Context Map, snapshots, migration backups, the Obsidian vault index, and diff output. Nothing sensitive is written to `.handoff/`, regardless of storage mode.

## Configuration File

`.handoff.config.json` is stored in the project root. It is portable project configuration: since v1.5.1 it is validated before every `init`, `save`, and `load`, and validation rejects absolute paths, home-relative paths (`~`, `$HOME`, `%USERPROFILE%`), parent traversal (`..`), and credential-like values anywhere in the file. The only exception is `storage.remote`, where existing submodule remote URLs remain supported.

A config that passes validation holds no machine-specific paths and no secrets, so it is safe — and recommended — to commit with the project. Never hand-write secrets, home paths, Vault paths, or machine-specific absolute paths into it. (The Obsidian Vault path lives in the user-level config, not here.)

**direct mode:**
```json
{
  "version": "2.0.0",
  "storage": {
    "mode": "direct",
    "path": ".handoff"
  }
}
```

**submodule mode:**
```json
{
  "version": "2.0.0",
  "storage": {
    "mode": "submodule",
    "path": ".handoff",
    "remote": "git@github.com:USER/PROJECT-handoff.git"
  }
}
```

## Directory Structure

```
.handoff/
  context-map.md  # Canonical human-editable semantic state (v2)
  HANDOFF.md      # Generated view — do not edit
  tasks.md        # Generated view — do not edit
  decisions.md    # Generated view — do not edit
  context.json    # Metadata, git state, view hashes, diagnostics (no semantic fields)
  history/
    snapshots/    # Bounded semantic snapshots (diff baseline)
    migrations/   # Sensitive-filtered backups of pre-migration originals
```

## Template Reference

See assets for output format:
- `assets/HANDOFF.template.md`
- `assets/context.template.json`
- `assets/tasks.template.md`
- `assets/decisions.template.md`
- `assets/context-map.template.md`

## Command Details

For full command specifications:
- `references/save.md`
- `references/load.md`

## Scripts

Enhanced functionality (optional). Two runtimes supported:

**Deno (recommended):**
- `scripts/save.ts`
- `scripts/load.ts`
- `scripts/adapter.ts` - Obsidian adapter commands (`obsidian link|status|unlink`)
- `scripts/diff.ts` - Semantic context diff (`--from latest|<snapshot-id>`, `--format markdown|json`)
- `scripts/view.ts` - View stub; returns `VIEW_REQUIRES_NODE` (Viewer daemon is Node.js-only)

**Node.js:**
- `scripts/node/save.mjs`
- `scripts/node/load.mjs`
- `scripts/node/adapter.mjs` - Obsidian adapter commands (`obsidian link|status|unlink`)
- `scripts/node/diff.mjs` - Semantic context diff (`--from latest|<snapshot-id>`, `--format markdown|json`)
- `scripts/node/view.mjs` - Context Map Viewer daemon CLI (`--idle-minutes N`, `--json`)

**Shared core (runtime-agnostic ESM imported by both runtimes, so behavior stays identical):**
- `scripts/context-map.mjs` - Context Map parsing, reconciliation, rendering, and sanitization.
- `scripts/views.mjs` - Deterministic view generation, SHA-256 view hashes, and tamper warnings.
- `scripts/migrate.mjs` - Atomic legacy-to-v2 migration (pure planner + io-injected applier).
- `scripts/context-compiler.mjs` - Focused-load compiler (`--focus`/`--budget`/`--full`).
- `scripts/snapshots.mjs` - Bounded, sanitized semantic snapshots.
- `scripts/context-diff.mjs` - Semantic diff core; matches nodes by normalized content, section, and hierarchy (no persistent IDs); strictly read-only.
- `scripts/config.mjs` - Portable-config validation.
- `scripts/source-comments.mjs` - Comment-aware TODO/FIXME scanner.
- `scripts/adapters/obsidian.mjs` - Obsidian adapter core with an injected `io` seam for symlink/junction operations.

Verified by fixture-based tests in `tests/` (`deno test --allow-read --allow-write --allow-run --allow-env tests/deno/` and `node --test "tests/node/**/*.test.mjs"`).

The skill works purely via prompt - scripts provide additional capabilities when available.

## Multi-Agent Usage

Different agents can collaborate through the `.handoff/` directory:

1. Agent A runs `/handoff save`
2. Agent B runs `/handoff load`
3. Agent B continues work with full context

The protocol is agent-agnostic - any compliant agent can read/write the same format.
