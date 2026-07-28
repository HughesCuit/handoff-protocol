# /handoff save

Save current work context to `.handoff/` directory.

## Usage

```
/handoff save [mode] [--lang CODE] [--verbosity LEVEL]
```

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Standard save with current state summary |
| `compact` | Minimal summary - goal + status + next steps only |
| `full` | Maximum context - all details, extended history |
| `diff` | Focus on code changes - diff-centric output |

## Options

### `--lang CODE`

Control the language of generated handoff content.

| Value | Language |
|-------|----------|
| `zh` | 中文 (Chinese) |
| `en` | English |
| `ja` | 日本語 (Japanese) |
| `ko` | 한국어 (Korean) |
| `de` | Deutsch (German) |
| `fr` | Français (French) |
| `es` | Español (Spanish) |
| (omit) | Auto-detect from conversation language |

**Behavior:**
- When `--lang` is specified, ALL generated text content (section headers, status descriptions, risk items, recommendations, notes) MUST be written in the specified language.
- When `--lang` is omitted, the agent MUST follow the language used in the current conversation session. If the conversation is in Chinese, output in Chinese. If in English, output in English.
- Machine-readable fields in `context.json` (field names, status enums, priority values) remain in English for interoperability. Only human-readable string values are translated.
- Git commit messages are preserved as-is (not translated).

### `--verbosity LEVEL`

Control the detail level of generated handoff content.

| Level | Description | Default |
|-------|-------------|---------|
| `low` | Minimal output | |
| `med` | Standard output | ✓ |
| `high` | Maximum detail | |

**Behavior by level:**

#### `low`
- Current goal (1 line)
- Status (1 line)
- Next steps (3 items max)
- 3 recent commits
- No TODO/FIXME scan
- No risk analysis
- No diff stats
- Generated files: context-map.md + HANDOFF.md view + context.json (skip tasks.md, decisions.md views)

#### `med` (default)
- Full goal description
- Detailed status
- Next steps (up to 8)
- 5 recent commits
- TODO/FIXME scan (up to 20 items)
- Risk analysis enabled
- Diff stats included
- Generated files: context-map.md + all views (HANDOFF.md, tasks.md, decisions.md) + context.json

#### `high`
- Full goal description with context
- Detailed status with file-level breakdown
- Next steps (up to 15, with rationale)
- 20 recent commits
- TODO/FIXME scan (up to 50 items)
- Full risk analysis with severity levels
- Full diff stats with per-file breakdown
- Extended architecture notes
- Generated files: context-map.md + all views + context.json + optional `analysis.md` (detailed codebase analysis)

## Pre-Flight Checks

Before saving, the script must:

### 1. Check Storage Configuration

Read `.handoff.config.json` from project root.

**If found:** validate it before doing anything else (v1.5.1). The file is portable project configuration: `storage.mode` must be `direct` or `submodule`, `storage.path` must be a non-empty relative path, and no value outside `storage.remote` may be an absolute path, a home-relative path (`~`, `$HOME`, `%USERPROFILE%`), a parent-traversal path (`..`), or a credential-like value. If validation fails, report each error and stop:

```
Error: invalid .handoff.config.json:
  - storage.path: absolute paths are not portable; keep .handoff.config.json machine-independent
Fix the file, or remove it and run `/handoff init` to reconfigure storage.
```

A config that passes validation is safe and recommended to commit with the project.

**If not found:**

```
Handoff storage is not configured.

Choose where to store .handoff:

1. direct
   Store .handoff/ directly in this project.
   Recommended for private repositories or local-only projects.

2. submodule
   Store .handoff/ as a Git submodule.
   Recommended for public repositories where handoff context should not be exposed.

Please choose: direct or submodule.
```

If user selects `submodule`, prompt for private repo URL:

```
Please provide the private handoff repository URL.
Example: git@github.com:USER/PROJECT-handoff.git
```

### 2. Validate Storage Mode

**direct mode:**
- Ensure `.handoff/` exists (create if not)
- Check if `.handoff/` is in `.gitignore`
- If project has a remote and `.handoff/` is NOT in `.gitignore`, warn:

```
Warning: .handoff/ may contain private context.

For public repositories, consider adding .handoff/ to .gitignore
or use submodule mode.
```

**submodule mode:**
- Verify `.handoff` is registered as a git submodule (check `.gitmodules`)
- If not initialized, run:

```bash
git submodule update --init --recursive .handoff
```

- If initialization fails (likely private repo access issue):

```
Unable to initialize .handoff submodule.

This may be a private repository. Please make sure your SSH key
or GitHub credentials have access to the remote repository.
```

## Execution Steps

### 1. Parse Options

Extract `mode`, `--lang`, and `--verbosity` from the command:

```
/handoff save                    → mode=default, lang=auto, verbosity=med
/handoff save full               → mode=full, lang=auto, verbosity=med
/handoff save --lang zh          → mode=default, lang=zh, verbosity=med
/handoff save full --lang en --verbosity high  → mode=full, lang=en, verbosity=high
/handoff save --verbosity low    → mode=default, lang=auto, verbosity=low
```

**Priority rules:**
- If `mode` is `compact` and `--verbosity` is also specified, `--verbosity` takes precedence for the detail level, but `compact` mode still applies its own constraints (e.g., reduced commit count).
- If `mode` is `full` and `--verbosity` is `low`, use `low` verbosity behavior (verbosity overrides mode for detail level).

### 2. Migrate Legacy Handoffs (v2)

If the existing `.handoff/` is a legacy 1.x / v1.5 handoff (including a v1.5 map-only or mixed handoff that predates v2), migrate it first — atomically — before generating new state. See **Legacy Migration** below. Already-migrated v2 handoffs skip this step.

### 3. Collect Git State

```bash
git status
git diff --stat
git log --oneline -5
git branch --show-current
```

If git unavailable, fall back to:
- Scan recently modified files
- Analyze project structure
- Extract TODO/FIXME comments

### 4. Analyze Current State

Determine:
- Current goal (inferred from recent commits)
- Progress status (from git working state)
- Modified files (from `git status --porcelain`)
- TODO/FIXME items (scanned from source file comments; strings, template literals, and Markdown examples are ignored)
- Risk factors (high-priority items, untracked files)

The depth of analysis is controlled by `--verbosity`:

| Analysis | low | med | high |
|----------|-----|-----|------|
| Commit history | 3 | 5 | 20 |
| TODO scan | ✗ | ✓ (20) | ✓ (50) |
| Risk analysis | ✗ | ✓ | ✓ (extended) |
| Diff stats | ✗ | ✓ | ✓ (per-file) |
| Architecture notes | ✗ | ✗ | ✓ |

### 5. Security Filter

**MUST NOT include:**
- API keys (generic, GitHub `ghp_*`, GitLab `glpat-*`, AWS `AKIA*`)
- Bearer tokens, JWT tokens
- Cookies, passwords
- Private keys (PEM, SSH)
- Connection strings with credentials
- Cloud service credentials (GCP, Azure)
- OAuth tokens, OpenAI API keys
- `.env` contents

Filter before writing to any `.handoff/` file — including snapshots and migration backups.

### 6. Generate Output Files

Since v2, `context-map.md` is the only writable source of semantic state. Everything else is derived from it.

#### context-map.md (canonical semantic state)

Generated or reconciled on **every** save, at every mode and verbosity level (including `low`).

The map has eight semantic sections: Current Goal, Current Status, Tasks, Decisions, Open Questions, Risks, Knowledge and Notes, Excluded. With `--lang`, section headings are localized; parsing maps them back to the fixed semantic keys.

**Reconciliation rules:**
- Existing user nodes are preserved verbatim, in order, and are never overwritten or removed. Direct user edits take priority over agent inference.
- Nodes ending with `<!-- agent -->` are agent-managed: they are replaced by fresh inference for that section, but only when the new inference is non-empty (so a low-verbosity save never degrades the map).
- Current Goal and Current Status are single-value sections: if the user wrote a value, inference is suppressed for that section.
- An inferred node that is a semantic duplicate of an existing node (compared case-insensitively, ignoring checkbox state, priority markers, and punctuation) is not appended, so repeated saves are idempotent.
- The sensitive-data filter (step 5) is applied before any map content is written.

See `assets/context-map.template.md` for the full layout.

#### HANDOFF.md, tasks.md, decisions.md (generated views)

Deterministic views rendered from the map (plus save-time machine metadata). Every view begins with:

```
<!-- generated-from: context-map.md; do not edit -->
```

- `tasks.md` and `decisions.md` views are skipped at `low` verbosity (their hash entries in `context.json` are preserved, so tamper detection keeps working).
- On save, any view whose on-disk content no longer matches its stored hash produces a warning naming the file; the manual edit is never imported into the map and is overwritten by regeneration. To change semantic state, edit `context-map.md`.

#### context.json (v2, machine-readable metadata)

Carries **no semantic fields** — the Context Map is the only semantic source.

```json
{
  "version": "2.0.0",
  "timestamp": "ISO-8601",
  "agent": "opencode",
  "project": "project-name",
  "lang": null,
  "git": {
    "branch": "main",
    "latest_commit": "abc1234",
    "commit_message": "msg",
    "is_dirty": true
  },
  "views": {
    "HANDOFF.md": "sha256-of-the-written-view",
    "tasks.md": "sha256-of-the-written-view",
    "decisions.md": "sha256-of-the-written-view"
  },
  "diagnostics": {
    "migration": [],
    "conflicts": []
  }
}
```

- `views` holds SHA-256 hashes of the generated views as written; loaders and savers compare on-disk contents against these hashes to surface manual edits.
- `diagnostics.migration` records what a legacy migration consumed; `diagnostics.conflicts` mirrors the "Migration conflict" nodes.

### 7. Write Semantic Snapshot

After writing the files, compare the map's semantic state against the latest snapshot under `.handoff/history/snapshots/` and write a new snapshot **only when the semantic state changed**. Snapshots are sanitized (sensitive-data filter applied, generated fingerprints stripped), bounded to the 20 most recent (pruned oldest-first, snapshot-pattern files only), and are the baseline for `/handoff diff`.

### 8. Write Files and Commit

**direct mode:**
1. Write files to `.handoff/` (file count depends on verbosity)
2. Do NOT auto-commit
3. Remind user to decide whether to commit `.handoff/`

**submodule mode:**
1. Ensure submodule is initialized
2. Write files to `.handoff/`
3. Inside `.handoff/`:

```bash
git add HANDOFF.md context.json tasks.md decisions.md context-map.md
git commit -m "Update handoff context"
git push
```

4. Return to parent project
5. Remind user:

```
Handoff context has been saved and pushed to the .handoff submodule.

The parent repository now has an updated submodule pointer.
Commit it in the parent repository only if you want collaborators
to use this exact handoff revision.
```

## Legacy Migration (v2)

Legacy 1.x and v1.5 handoffs migrate automatically on the next save. `load` never migrates — it reads legacy handoffs unchanged and prints a note that migration is available.

**Precedence (highest first):**
1. Explicit current user instructions and direct Context Map edits
2. Structured legacy `context.json`
3. Human-readable legacy files (`tasks.md`, `decisions.md`, `HANDOFF.md`)

Singleton fields (goal, status) have exactly one winner. Superseded lower-priority values are never dropped: they stay visible as child nodes under an Open Questions "Migration conflict" node, each labeled with its source file (e.g. `(source: context.json)`), and are mirrored into `diagnostics.conflicts`. List sections merge across sources in precedence order with semantic deduplication, so task state, decision rationale, risks, questions, and exclusions are all preserved — no silent loss.

**Atomicity and backup:**
1. The migration plan is computed purely (no I/O) and validated, along with every output.
2. All outputs are written through temporary sibling files and re-validated.
3. The originals — including `.handoff.config.json` — are backed up under `.handoff/history/migrations/<UTC-timestamp>/`.
4. Only then is each temp file renamed into place; the config (the version upgrade) renames last.

Any failure **before** the rename phase leaves the original files and configuration untouched and cleans up temporary files. If a failure strikes **during** the rename phase, recovery is manual: copy the originals back from `.handoff/history/migrations/<UTC-timestamp>/` (including `.handoff.config.json`) and re-run `/handoff save`.

**Backups are sensitive-data filtered.** If a legacy file contained credential-like content, its backup copy holds the filtered text, not the original bytes — do not rely on the backup to recover secrets.

Migration is idempotent: an already-migrated v2 handoff needs no migration and creates no second backup.

## Verbosity-Specific Behavior Summary

| Feature | low | med | high |
|---------|-----|-----|------|
| Commit count | 3 | 5 | 20 |
| TODO scan | ✗ | ✓ (max 20) | ✓ (max 50) |
| Risk analysis | ✗ | ✓ | ✓ (extended) |
| Diff stats | ✗ | ✓ | ✓ (per-file) |
| Next steps limit | 3 | 8 | 15 |
| context-map.md | ✓ | ✓ | ✓ |
| HANDOFF.md view | ✓ | ✓ | ✓ |
| tasks.md view | ✗ | ✓ | ✓ |
| decisions.md view | ✗ | ✓ | ✓ |
| analysis.md | ✗ | ✗ | ✓ |
| Semantic snapshot | on change | on change | on change |

## Mode vs Verbosity Interaction

When both `mode` and `--verbosity` are specified:

| mode \ verbosity | low | med | high |
|------------------|-----|-----|------|
| (default) | low behavior | med behavior | high behavior |
| `compact` | low behavior | low behavior | med behavior |
| `full` | med behavior | high behavior | high behavior |
| `diff` | low behavior + diff | med behavior + diff | high behavior + diff |

Rule: `--verbosity` sets the detail floor. `mode` adds behavior on top.

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `.handoff.config.json` | Trigger init flow |
| Invalid `.handoff.config.json` | Report each validation error and stop |
| No `.handoff/` directory | Create it |
| Submodule not initialized | Run `git submodule update --init` |
| Submodule access denied | Clear error about SSH/credential access |
| Git not available | Use file scanning fallback |
| No changes detected | Save current state anyway |
| Permission error | Report error, suggest fix |
| Invalid `--lang` value | Warn and fall back to conversation language |
| Invalid `--verbosity` value | Error: show valid values (low, med, high) |
| Legacy handoff detected | Migrate atomically with backup, then save |
| Generated view manually edited | Warn, regenerate from the map (never import the edit) |

## Examples

```bash
# Standard save (follows conversation language, med verbosity)
/handoff save

# Save in Chinese with low verbosity
/handoff save --lang zh --verbosity low

# Full save in English with high verbosity
/handoff save full --lang en --verbosity high

# Quick summary for status update
/handoff save compact

# Full context for complex handoff in Japanese
/handoff save full --lang ja

# Minimal English save
/handoff save --lang en --verbosity low

# Focus on what changed with high detail
/handoff save diff --verbosity high
```
