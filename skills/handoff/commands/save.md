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
- Current goal (what are we working on?)
- Progress status (what's done? what's pending?)
- Modified files (what changed?)
- Blockers (what's blocking progress?)
- Next steps (what should happen next?)

### 3. Security Filter

**MUST NOT include:**
- API keys (any pattern: `sk-*`, `key=*`, etc.)
- Bearer tokens
- Cookies
- Passwords
- Private keys
- `.env` contents
- Any secret/credential patterns

Filter before writing to any `.handoff/` file.

### 4. Generate Output Files

#### HANDOFF.md (Human-readable)

Follow template: `templates/HANDOFF.template.md`

Structure:
```markdown
# Project Handoff

## Current Goal
[one-line goal]

## Current Status
[progress summary]

## Completed Work
- [item]
- [item]

## Modified Files
- `path/to/file` - [what changed]

## Architecture Decisions
- [decision and rationale]

## Outstanding Issues
- [blocker or issue]

## TODO
- [ ] [pending task]

## Recommended Next Steps
1. [actionable step]

## Risks / Notes
- [risk or important note]
```

#### context.json (Machine-readable)

Follow template: `templates/context.template.json`

```json
{
  "project": "project-name",
  "current_goal": "description",
  "status": "in-progress|blocked|completed",
  "completed": ["item1", "item2"],
  "modified_files": ["file1", "file2"],
  "todos": ["task1", "task2"],
  "blockers": ["blocker1"],
  "decisions": ["decision1"],
  "next_steps": ["step1", "step2"],
  "git": {
    "branch": "main",
    "latest_commit": "abc1234"
  }
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
- **Date**: YYYY-MM-DD
- **Context**: [why this decision was needed]
- **Decision**: [what was decided]
- **Rationale**: [why this approach]
- **Consequences**: [impact]
```

## Mode-Specific Behavior

### compact

Minimal output:
- Current goal (1 line)
- Status (1 line)
- Next steps (3 items max)

Skip: detailed file lists, full git history, extended analysis.

### full

Extended output:
- Full git log (last 20 commits)
- Complete file change list
- Detailed analysis of each change
- Extended risk assessment
- Alternative approaches considered

### diff

Diff-centric output:
- Emphasize code changes
- Include relevant diff snippets
- Focus on what changed, not why
- Minimal status/overview content

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `.handoff/` directory | Create it |
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
