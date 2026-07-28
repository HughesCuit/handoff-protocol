---
name: handoff
description: Cross-agent context handoff protocol. Save and restore work context across AI coding agents (OpenCode, Codex, MimoCode, Claude Code, OpenHands, Cursor Agent, etc.). Use when switching between agents or collaborating with other AI assistants.
license: MIT
metadata:
  author: handoff-protocol
  version: "2.0.0"
---

# Handoff Protocol Skill

Cross-agent context handoff protocol. Save and restore work context across AI coding agents.

## Overview

The Handoff Protocol provides a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

When invoked, the skill manages a `.handoff/` directory that serves as the Agent Context Protocol - similar to `.git/` for version control, but for AI agent collaboration.

## Context Map (v1.5)

`.handoff/context-map.md` is a human-editable Markdown tree that indexes the session state. It is generated on every `/handoff save` (all modes and verbosity levels) and read first on every `/handoff load`.

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
2. Analyze current work state (TODO/FIXME, commit history, risk factors)
3. Generate `.handoff/HANDOFF.md` (human-readable)
4. Generate `.handoff/context.json` (machine-readable)
5. Generate `.handoff/tasks.md` (pending work)
6. Generate `.handoff/decisions.md` (architecture decisions)
7. Generate or reconcile `.handoff/context-map.md` (every mode and verbosity; preserves user edits, deduplicates semantic nodes)
8. For submodule mode: commit and push to submodule repo (including `context-map.md`)

### /handoff load [mode]

Read and restore context from `.handoff/`.

**Modes:**
- (default) - Standard read and summarize
- `auto` - Auto-infer next steps
- `merge` - Merge with current context

**Pre-checks:**
1. Read `.handoff.config.json` to determine storage mode
2. For submodule mode: verify submodule is initialized, run `git submodule update --init --recursive .handoff` if needed

**Execution:**
1. Read `.handoff/` contents
2. Read `context-map.md` first (semantic source); supplement with machine state from `context.json`
3. If the map is absent, empty, or malformed, fall back to `context.json`, then `HANDOFF.md` (legacy 1.x behavior, no migration needed)
4. Summarize current state
5. Generate recommended next actions

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

Nothing sensitive is written to `.handoff/`, regardless of storage mode.

## Configuration File

`.handoff.config.json` is stored in the project root. It is portable project configuration: since v1.5.1 it is validated before every `init`, `save`, and `load`, and validation rejects absolute paths, home-relative paths (`~`, `$HOME`, `%USERPROFILE%`), parent traversal (`..`), and credential-like values anywhere in the file. The only exception is `storage.remote`, where existing submodule remote URLs remain supported.

A config that passes validation holds no machine-specific paths and no secrets, so it is safe — and recommended — to commit with the project. Never hand-write secrets, home paths, Vault paths, or machine-specific absolute paths into it.

**direct mode:**
```json
{
  "version": "1.5.1",
  "storage": {
    "mode": "direct",
    "path": ".handoff"
  }
}
```

**submodule mode:**
```json
{
  "version": "1.5.1",
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
  HANDOFF.md      # Human-readable context
  context.json    # Machine-readable state
  tasks.md        # Pending tasks
  decisions.md    # Architecture decisions
  context-map.md  # Human-editable context map (v1.5)
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

**Node.js:**
- `scripts/node/save.mjs`
- `scripts/node/load.mjs`

**Shared core:**
- `scripts/context-map.mjs` - Context Map parsing, reconciliation, rendering, and sanitization. Runtime-agnostic ESM imported by both runtimes, so behavior stays identical. Verified by fixture-based tests in `tests/` (`deno test --allow-read --allow-write --allow-run --allow-env tests/deno/` and `node --test "tests/node/**/*.test.mjs"`).

The skill works purely via prompt - scripts provide additional capabilities when available.

## Multi-Agent Usage

Different agents can collaborate through the `.handoff/` directory:

1. Agent A runs `/handoff save`
2. Agent B runs `/handoff load`
3. Agent B continues work with full context

The protocol is agent-agnostic - any compliant agent can read/write the same format.
