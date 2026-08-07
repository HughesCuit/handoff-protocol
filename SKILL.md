---
name: handoff
description: Cross-agent context handoff protocol. Save and restore work context across AI coding agents. Core workflow verified on Codex, Claude Code, OpenCode, and Kimi Code CLI; compatible with OpenHands and Cursor, and expected to work in other hosts that support basic skills. Use when switching between agents or collaborating with other AI assistants.
license: MIT
metadata:
  author: handoff-protocol
  version: "3.0.1"
---

# Handoff Protocol Skill

Cross-agent context handoff protocol. Save and restore work context across AI coding agents.

## Overview

The Handoff Protocol provides a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

When invoked, the skill manages a `.handoff/` directory that serves as the Agent Context Protocol - similar to `.git/` for version control, but for AI agent collaboration.

## Canonical State (v3)

Since v3, the Context Map is a **directory**, not a single document. `.handoff/context-map.md` is a compact semantic directory that owns stable node IDs, labels, hierarchy, and lightweight state; the full node content (summary + detail body) lives in eight section files under `.handoff/content/`, keyed by those IDs. Together they are the only writable source of semantic state, reconciled on every `/handoff save` and read on every `/handoff load`.

- `context-map.md` — the directory. Each node line owns a stable ID, a label, hierarchy, task state, and compact metadata (task priority / risk severity). Example: `- [ ] \`task1\` **high** Complete the migration`.
- `content/<section>.md` — the bodies. Eight fixed files (`current-goal.md`, `current-status.md`, `tasks.md`, `decisions.md`, `open-questions.md`, `risks.md`, `knowledge-notes.md`, `excluded.md`). Each `## <id>` heading keys an entry to a directory node; the first paragraph is the required summary, remaining paragraphs are the verbatim detail body. Labels are NOT duplicated here.
- `views/HANDOFF.md` — the only generated view, regenerated from the directory + bodies on every save. It begins with `<!-- generated-from: context-map.md + content/*.md; do not edit -->`. The v2 root-level `HANDOFF.md`, `tasks.md`, and `decisions.md` are retired.
- `context.json` (v3) carries no semantic fields — only `protocolVersion` (`3.0.0`), protocol metadata, Git state, monotonic ID counters, SHA-256 hashes of the directory, every content file, and the view, plus diagnostics.

A manually edited generated view produces a warning naming the file; the edit is **never imported** and is overwritten on the next save. To change semantic state, edit `context-map.md` (labels/structure/state) and the `content/` files (summaries/bodies).

**Stable IDs:**
- IDs use a section-derived prefix and an increasing integer: `goal1`, `status1`, `task1`, `decision1`, `question1`, `risk1`, `note1`, `excluded1`.
- IDs are immutable and never reused, even after a node is deleted. Renaming or moving a node keeps its ID (the body follows the node to its new section file).
- `context.json.idCounters` stores the high-water mark per prefix; if missing or damaged it is reconstructed from durable state.

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
- Each node is a concise, independently understandable statement; its body carries the detail.
- Nested list indentation expresses parent-child relationships and MUST be preserved when reading, reconciling, and writing the directory.
- Prefer updating or moving an existing node over appending a semantic duplicate.
- Directory ownership (ID, label, parent, order, task state, priority, severity) and body ownership (summary, body) are independent. Direct user edits always win over agent inference in their own domain. Generated nodes/entries carry an `<!-- agent -->` marker and a hidden fingerprint; editing transfers ownership automatically.
- Current Goal may be empty. Commit messages (including release commits) describe history and must NEVER be inferred as the Current Goal — only an explicit user goal or an existing valid goal populates that section.
- Apply the sensitive-data filter before writing or displaying any Context Map content.

**Update the map only on stable state events**, not after every conversational turn:
- A goal or status change
- A task lifecycle change (added, started, completed)
- A stable decision or conclusion
- A new open question or risk
- A solution explicitly excluded
- An explicit user request to add, update, or remove a node

**Exclude from the map:** greetings, transient speculation, chain-of-thought, secrets, and details with no future value.

**Editing:** users edit the directory and content files directly (Markdown) or by asking in natural language (e.g. "add a risk about X", "mark task Y done"). No new slash command is introduced.

## Snapshots

Every save compares the canonical state's semantic content against the latest snapshot under `.handoff/history/snapshots/` and writes a new snapshot **only when the semantic state changed**. v3 snapshots normalize the complete state — every node keeps its stable ID, section, parent linkage, document order, label, lightweight state, summary, and complete body — after sensitive-data filtering and ownership-fingerprint stripping. Snapshots are bounded: the 20 most recent are kept, pruned oldest-first, and only files matching the snapshot naming pattern are ever pruned. Snapshots are the baseline for `/handoff diff`.

## Migration to v3 (from v2 and legacy 1.x / v1.5)

v3 is a breaking storage-layout change. Existing v2 (and legacy 1.x / v1.5) handoffs remain readable — `load` handles them read-only and prints a note that the next save migrates. The first `/handoff save` migrates automatically and atomically:

1. **Precedence:** explicit user instructions and direct Context Map edits win over structured `context.json`, which wins over the human-readable files (`tasks.md`, `decisions.md`, `HANDOFF.md`), which win over inference. Singleton fields (goal, status) get exactly one winner; superseded values are never dropped — they stay visible as their own attributed nodes under an Open Questions "Migration conflict" node, each labeled with its source file, and are mirrored into `diagnostics.conflicts`.
2. **Stable IDs:** every migrated node — including nested children — receives a stable ID by section and document order. The complete original node text becomes the body entry's summary; the label is derived deterministically (text through the first clause delimiter, limited to 60 code points with an ellipsis when truncated).
3. **Atomic write:** all outputs are written through temporary sibling files and validated; the originals (including `.handoff.config.json`) are backed up (sensitive-data filtered) under `.handoff/history/migrations/<UTC-timestamp>/`; only then is each temp file renamed into place, with the config version upgrade renamed last. The old root `HANDOFF.md`, `tasks.md`, and `decisions.md` are retired after a successful migration and remain in the backup.
4. **Rename-phase failures roll back.** If any rename fails mid-phase, every file already replaced is restored from its pre-rename sibling, leaving the original files byte-identical; the migration can then be re-run safely. Cleanup after the commit point is best-effort and can never trigger a destructive rollback.

Migration is idempotent: an already-migrated v3 handoff needs no migration and creates no second backup. See `docs/migrations/v2-to-v3.md` for the full guide. **Do not manually copy old root `tasks.md` or `decisions.md` into `content/`** — let the migration produce the content files.

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
3. Detect the layout; if a pre-v3 handoff (v2 or legacy 1.x) is present, migrate it first (see Migration; originals are backed up under `.handoff/history/migrations/`)
4. Load the canonical v3 state and reconcile it with verified evidence (every mode and verbosity; preserves user-owned labels and bodies, deduplicates semantic nodes, allocates IDs only for genuinely new nodes, never infers a goal)
5. Atomically write `context-map.md`, the eight `content/` files, `views/HANDOFF.md`, and `context.json` (metadata + ID counters + file hashes)
6. Write a semantic snapshot under `.handoff/history/snapshots/` if the semantic state changed
7. For submodule mode: commit and push to submodule repo (including `context-map.md`, `content/`, `views/`, `context.json`)

### /handoff load [mode] [--focus TEXT] [--effort LEVEL] [--budget N] [--full]

Read and restore context from `.handoff/`.

**Modes:**
- (default) - Standard read and summarize
- `auto` - Auto-infer next steps
- `merge` - Merge with current context

**Options (context compiler):**
- `--focus TEXT` - Compile the map down to the nodes relevant to this text. Current Goal and Current Status (and their ancestors) are always kept; other nodes are selected by deterministic keyword-overlap scoring.
- `--effort LEVEL` - Per-load detail level: `min`, `low`, `med`, `high`, `max`. Default: `med`. Effort controls context compilation only — it is chosen on every load, is never persisted to project configuration, and body files always retain their complete canonical content.
  - `min` - Context Map directory only; no bodies.
  - `low` - Directory plus first-paragraph summaries for selected nodes.
  - `med` - Complete bodies for selected nodes.
  - `high` - Complete bodies for selected nodes, their ancestors, and their direct subtrees.
  - `max` - Complete Map and all body entries.
- `--budget N` - Estimated token limit for the compiled context. Minimum `512`; lower or non-numeric values are rejected. When omitted there is no hidden hard cap — effort alone determines detail. When supplied, the budget is a hard limit that can degrade higher efforts: full bodies degrade to summaries, then to directory-only, and every degradation is reported.
- `--full` - Select all nodes; does not disable an explicitly supplied `--budget`.

Choose `min`/`low` for constrained context windows and `high`/`max` only when the task benefits from broad history. If no non-core node matches the focus reliably, the compiler safely falls back to the full map and reports the reason — focused load never omits core state. Without compiler flags the output carries no compiler diagnostics. Compilation is strictly read-only.

**Pre-checks:**
1. Read `.handoff.config.json` to determine storage mode
2. For submodule mode: verify submodule is initialized, run `git submodule update --init --recursive .handoff` if needed

**Execution:**
1. Read `.handoff/` contents
2. Read the canonical v3 state (`context-map.md` directory + `content/` bodies); supplement with machine state from `context.json`
3. If the directory is absent or unreadable, fall back to `views/HANDOFF.md`, then legacy `context.json`/`HANDOFF.md` (v2 / 1.x behavior, read-only)
4. Warn about a manually edited generated view (hash mismatch); semantics still come from the directory + bodies
5. Warn (read-only) when the handoff is a pre-v3 format that `/handoff save` would migrate
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

Compare a semantic snapshot against the current canonical state and report changes as separate groups. The default comparison is the latest snapshot under `.handoff/history/snapshots/` against the current state; `--from <snapshot-id>` pins an older snapshot. v3 layouts diff by stable ID and split changes into precise categories; v2 layouts use the legacy content-matching diff.

**Execution:**
1. Run `scripts/diff.ts` (Deno) or `scripts/node/diff.mjs` (Node.js) with the requested flags
2. Present the report; `--format json` emits stable arrays. v3 categories: `added`, `deleted`, `moved`, `labelEdited`, `summaryEdited`, `bodyEdited`, `taskStateChanged`, `attributesChanged` (priority/severity), each keyed by stable ID. v2 categories: `added`, `removed`, `edited`, `moved`, `taskStateChanged`.

**Safety rules:**
- Diff is strictly read-only: it never mutates snapshots, the Context Map, or any other file
- Comparison works on normalized semantic state, so localized headings and generated fingerprints never produce phantom changes; output is deterministic across Node and Deno
- v2 snapshots are never used as baselines for a v3 layout
- Output is sensitive-data filtered before display

### /handoff view [--idle-minutes N] [--json]

Open the current project's `.handoff/context-map.md` as a live, read-only mind map. Starts or reuses one user-level local Viewer daemon and returns a temporary, token-scoped loopback URL for the current project. **The Agent, not the command, decides how to open that URL** — in a side browser, system browser, external browser, or simply presented to the user. The command never opens a browser itself and never requires an MCP App or plugin.

The Viewer reads only the directory initially and loads each node's body lazily on demand through a token-scoped `GET /session/<token>/node/<id>` endpoint, so long bodies never bloat the initial map. Node bodies are cached per content version and rendered read-only with HTML escaped (no script execution). v2 layouts show a migration-required notice instead of node bodies.

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
- Does not change `.handoff/`, `context-map.md`, or the v3 schema

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
  "version": "3.0.0",
  "storage": {
    "mode": "direct",
    "path": ".handoff"
  }
}
```

**submodule mode:**
```json
{
  "version": "3.0.0",
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
  context-map.md          # Canonical semantic directory: stable IDs, labels, hierarchy, state
  content/
    current-goal.md       # Node bodies (summary + detail), keyed by stable ID
    current-status.md
    tasks.md
    decisions.md
    open-questions.md
    risks.md
    knowledge-notes.md
    excluded.md
  views/
    HANDOFF.md            # Generated view — do not edit
  context.json            # Metadata, git state, ID counters, file hashes, diagnostics (no semantic fields)
  history/
    snapshots/            # Bounded semantic snapshots (diff baseline)
    migrations/           # Sensitive-filtered backups of pre-migration originals
```

## Template Reference

See assets for output format:
- `assets/context-map.template.md`
- `assets/content/current-goal.md` (and the other seven `assets/content/*.md` section templates)
- `assets/HANDOFF.template.md`
- `assets/context.template.json`
- `assets/tasks.template.md`
- `assets/decisions.template.md`

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
- `scripts/context-map.mjs` - Context Map (v2 + v3 directory) parsing, reconciliation, rendering, and sanitization.
- `scripts/content-files.mjs` - v3 content-file registry (section → file, section → ID prefix).
- `scripts/handoff-state.mjs` - Canonical v3 state: content parsing/rendering, stable-ID allocation, ownership-aware reconciliation, and validation.
- `scripts/views.mjs` - Deterministic view generation (`views/HANDOFF.md`), SHA-256 file hashes, atomic multi-file writes, and tamper warnings.
- `scripts/migrate.mjs` - Atomic legacy-to-v2 migration (pure planner + io-injected applier).
- `scripts/migrate-v3.mjs` - Atomic v2-to-v3 migration (layout detection, pure planner, transactional applier).
- `scripts/context-compiler.mjs` - Effort-aware context compiler (`--focus`/`--effort`/`--budget`/`--full`).
- `scripts/snapshots.mjs` - Bounded, sanitized semantic snapshots (v2 + v3 normalized state).
- `scripts/context-diff.mjs` - Semantic diff core; v3 matches nodes by stable ID, v2 by normalized content; strictly read-only.
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
