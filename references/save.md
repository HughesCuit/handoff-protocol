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
- Generated files: HANDOFF.md + context.json only (skip tasks.md, decisions.md)

#### `med` (default)
- Full goal description
- Detailed status
- Next steps (up to 8)
- 5 recent commits
- TODO/FIXME scan (up to 20 items)
- Risk analysis enabled
- Diff stats included
- Generated files: all 4 (HANDOFF.md, context.json, tasks.md, decisions.md)

#### `high`
- Full goal description with context
- Detailed status with file-level breakdown
- Next steps (up to 15, with rationale)
- 20 recent commits
- TODO/FIXME scan (up to 50 items)
- Full risk analysis with severity levels
- Full diff stats with per-file breakdown
- Extended architecture notes
- Generated files: all 4 + optional `analysis.md` (detailed codebase analysis)

## Pre-Flight Checks

Before saving, the script must:

### 1. Check Storage Configuration

Read `.handoff.config.json` from project root.

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

### 2. Collect Git State

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

### 3. Analyze Current State

Determine:
- Current goal (inferred from recent commits)
- Progress status (from git working state)
- Modified files (from `git status --porcelain`)
- TODO/FIXME items (scanned from source files)
- Risk factors (high-priority items, untracked files)

The depth of analysis is controlled by `--verbosity`:

| Analysis | low | med | high |
|----------|-----|-----|------|
| Commit history | 3 | 5 | 20 |
| TODO scan | ✗ | ✓ (20) | ✓ (50) |
| Risk analysis | ✗ | ✓ | ✓ (extended) |
| Diff stats | ✗ | ✓ | ✓ (per-file) |
| Architecture notes | ✗ | ✗ | ✓ |

### 4. Security Filter

**MUST NOT include:**
- API keys (generic, GitHub `ghp_*`, GitLab `glpat-*`, AWS `AKIA*`)
- Bearer tokens, JWT tokens
- Cookies, passwords
- Private keys (PEM, SSH)
- Connection strings with credentials
- Cloud service credentials (GCP, Azure)
- OAuth tokens, OpenAI API keys
- `.env` contents

Filter before writing to any `.handoff/` file.

### 5. Generate Output Files

#### HANDOFF.md (Human-readable)

Structure varies by `--verbosity`:

**low verbosity:**
```markdown
# Project Handoff

**Saved**: ISO-8601 timestamp
**Agent**: agent-name
**Project**: project-name
**Branch**: current-branch

## Current Goal
[inferred from recent commits]

## Current Status
[brief status]

## Next Steps
1. [actionable step]
2. [second step]
3. [third step]
```

**med verbosity (default):**
```markdown
# Project Handoff

**Saved**: ISO-8601 timestamp
**Agent**: agent-name
**Project**: project-name
**Branch**: current-branch
**Commit**: hash - message

## Current Goal
[inferred from recent commits]

## Current Status
[progress summary from git state]

## Completed Work
- [item from recent commits]

## Modified Files
- `path/to/file` [change_type]

## Outstanding Issues
- [blocker or issue]

## TODO
- [ ] **priority** task (file:line)

## Recommended Next Steps
1. [actionable step]

## Risks / Notes
- [risk or important note]
```

**high verbosity:**
```markdown
# Project Handoff

**Saved**: ISO-8601 timestamp
**Agent**: agent-name
**Project**: project-name
**Branch**: current-branch
**Commit**: hash - message
**Language**: lang-code

## Current Goal
[detailed goal with context]

## Current Status
[detailed status with file-level breakdown]

## Completed Work
- [item from recent commits]

## Modified Files
- `path/to/file` [change_type] - [description of change]

## Outstanding Issues
- [blocker or issue]

## TODO
- [ ] **priority** task (file:line)

## Recommended Next Steps
1. [actionable step] - [rationale]

## Risks / Notes
- [risk or important note]

## Extended Analysis
[detailed codebase analysis, dependency changes, test coverage impact]
```

#### context.json (Machine-readable)

```json
{
  "version": "1.2.0",
  "timestamp": "ISO-8601",
  "agent": "opencode",
  "project": "project-name",
  "current_goal": "description",
  "status": "in-progress",
  "completed": ["item1", "item2"],
  "modified_files": [{"path": "file", "description": "", "change_type": "modified"}],
  "todos": [{"task": "task", "priority": "high", "status": "pending"}],
  "blockers": [],
  "decisions": [],
  "next_steps": [],
  "git": {
    "branch": "main",
    "latest_commit": "abc1234",
    "commit_message": "msg",
    "is_dirty": true
  },
  "risks": [],
  "notes": "",
  "lang": "zh",
  "verbosity": "med"
}
```

New fields in v1.2.0:
- `lang` (string): The language code used for this handoff's human-readable content.
- `verbosity` (string): The verbosity level used (`low`, `med`, `high`).

#### tasks.md (Pending Work)

Only generated when `verbosity` is `med` or `high`.

```markdown
# Pending Tasks

## High Priority
- [ ] [task]

## Medium Priority
- [ ] [task]

## Low Priority
- [ ] [task]
```

#### decisions.md (Architecture Decisions)

Only generated when `verbosity` is `med` or `high`.

```markdown
# Architecture Decisions

## [Decision Title]
- **Context**: [why this decision was needed]
- **Decision**: [what was decided]
- **Rationale**: [why this approach]
```

### 6. Write Files and Commit

**direct mode:**
1. Write files to `.handoff/` (file count depends on verbosity)
2. Do NOT auto-commit
3. Remind user to decide whether to commit `.handoff/`

**submodule mode:**
1. Ensure submodule is initialized
2. Write files to `.handoff/`
3. Inside `.handoff/`:

```bash
git add HANDOFF.md context.json tasks.md decisions.md
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

## Verbosity-Specific Behavior Summary

| Feature | low | med | high |
|---------|-----|-----|------|
| Commit count | 3 | 5 | 20 |
| TODO scan | ✗ | ✓ (max 20) | ✓ (max 50) |
| Risk analysis | ✗ | ✓ | ✓ (extended) |
| Diff stats | ✗ | ✓ | ✓ (per-file) |
| Next steps limit | 3 | 8 | 15 |
| tasks.md | ✗ | ✓ | ✓ |
| decisions.md | ✗ | ✓ | ✓ |
| analysis.md | ✗ | ✗ | ✓ |
| File descriptions | ✗ | ✗ | ✓ |

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
| No `.handoff/` directory | Create it |
| Submodule not initialized | Run `git submodule update --init` |
| Submodule access denied | Clear error about SSH/credential access |
| Git not available | Use file scanning fallback |
| No changes detected | Save current state anyway |
| Permission error | Report error, suggest fix |
| Invalid `--lang` value | Warn and fall back to conversation language |
| Invalid `--verbosity` value | Error: show valid values (low, med, high) |

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
