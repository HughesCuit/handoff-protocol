# /handoff save

Save current work context to `.handoff/` directory.

## Usage

```
/handoff save [mode]
```

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Standard save with current state summary |
| `compact` | Minimal summary - goal + status + next steps only |
| `full` | Maximum context - all details, extended history |
| `diff` | Focus on code changes - diff-centric output |

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

### 1. Collect Git State

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

### 2. Analyze Current State

Determine:
- Current goal (inferred from recent commits)
- Progress status (from git working state)
- Modified files (from `git status --porcelain`)
- TODO/FIXME items (scanned from source files)
- Risk factors (high-priority items, untracked files)

### 3. Security Filter

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

### 4. Generate Output Files

#### HANDOFF.md (Human-readable)

Structure:
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

#### context.json (Machine-readable)

```json
{
  "version": "1.1.0",
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
  "notes": ""
}
```

#### tasks.md (Pending Work)

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

```markdown
# Architecture Decisions

## [Decision Title]
- **Context**: [why this decision was needed]
- **Decision**: [what was decided]
- **Rationale**: [why this approach]
```

### 5. Write Files and Commit

**direct mode:**
1. Write all 4 files to `.handoff/`
2. Do NOT auto-commit
3. Remind user to decide whether to commit `.handoff/`

**submodule mode:**
1. Ensure submodule is initialized
2. Write all 4 files to `.handoff/`
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

## Mode-Specific Behavior

### compact

Minimal output:
- Current goal (1 line)
- Status (1 line)
- Next steps (3 items max)
- 3 recent commits, no TODO scan

### full

Extended output:
- Full git log (last 20 commits)
- Up to 50 TODO/FIXME items
- Extended risk assessment
- Full diff stats

### diff

Diff-centric output:
- Emphasize code changes
- Include diff summary
- 5 commits, no TODO scan

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

## Examples

```bash
# Standard save
/handoff save

# Quick summary for status update
/handoff save compact

# Full context for complex handoff
/handoff save full

# Focus on what changed
/handoff save diff
```
