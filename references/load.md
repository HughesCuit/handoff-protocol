# /handoff load

Read and restore work context from `.handoff/` directory.

## Usage

```
/handoff load [mode]
```

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Read context and summarize |
| `auto` | Auto-infer next steps based on state |
| `merge` | Merge with current working context |

## Execution Steps

### 1. Read .handoff/ Contents

Check for:
- `.handoff/HANDOFF.md`
- `.handoff/context.json`
- `.handoff/tasks.md`
- `.handoff/decisions.md`

If `.handoff/` missing, report: "No handoff context found. Run `/handoff save` first."

### 2. Parse Files

#### Parse HANDOFF.md
Extract sections:
- Current Goal
- Current Status
- Completed Work
- Modified Files
- Outstanding Issues
- TODO
- Recommended Next Steps

#### Parse context.json
Extract structured data:
- project, current_goal, status
- completed, modified_files, todos
- blockers, decisions, next_steps
- git branch and latest commit

#### Parse tasks.md
Categorize pending tasks:
- High priority
- Medium priority
- Low priority

### 3. Generate Summary

**MUST output in this format:**

```
Current understanding:
[2-3 sentence summary of project state, current goal, and progress]

Recommended next actions:
1. [most important next step]
2. [second priority]
3. [third if applicable]

Potential risks:
- [known blocker or risk]
- [another if applicable]
```

### 4. Mode-Specific Behavior

#### (default) Standard Load

Output:
1. Current understanding (summary)
2. Recommended next actions (3 items)
3. Potential risks (if any)
4. Pending tasks count

#### auto - Auto-Infer

Enhanced analysis:
1. Analyze blockers → suggest resolutions
2. Analyze incomplete tasks → prioritize
3. Check git state → suggest sync if needed
4. Generate detailed action plan

Output includes:
- All default output
- Detailed action plan with rationale
- Dependency analysis
- Estimated effort per task

#### merge - Context Merge

Merge handoff context with current state:

1. Load handoff context
2. Compare with current git state
3. Identify:
   - New changes since handoff
   - Conflicting changes
   - Completed tasks (marked done in current, pending in handoff)
4. Generate merged context

Output includes:
- Delta summary (what changed since handoff)
- Conflict warnings (if any)
- Updated recommended actions

## Output Examples

### Standard Load

```
Current understanding:
Project: API Gateway Service
Status: In progress - implementing rate limiting middleware
Goal: Add rate limiting to protect backend services

Recommended next actions:
1. Complete rate limiter implementation in src/middleware/rate-limiter.ts
2. Add unit tests for rate limiting logic
3. Update API documentation with rate limit headers

Potential risks:
- Redis dependency not yet configured in staging environment
```

### Auto-Infer

```
Current understanding:
[as above]

Action plan:
1. [HIGH] Fix Redis connection - blocks rate limiter testing
   - File: src/config/redis.ts
   - Estimated: 30min

2. [HIGH] Complete rate-limiter.ts implementation
   - Missing: sliding window algorithm
   - Estimated: 2h

3. [MED] Add integration tests
   - Depends on: #1, #2
   - Estimated: 1h

Dependencies:
- #2 depends on #1
- #3 depends on #1, #2

Total estimated effort: 3.5h
```

### Merge

```
Delta since handoff:
- 3 new commits on main
- 2 files modified outside handoff context
- 1 task completed (was pending in handoff)

Conflicts:
- src/config.ts modified both in handoff and current work

Updated actions:
[merged recommendations]
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `.handoff/` | "No handoff context found" |
| Empty files | Warn, skip empty sections |
| Invalid JSON | Warn, use HANDOFF.md only |
| Missing sections | Skip, note in output |

## Security

When displaying loaded context:
- Verify no secrets in output
- Filter any unexpected sensitive patterns
- Warn if suspicious content detected

## Examples

```bash
# Standard load
/handoff load

# Get detailed action plan
/handoff load auto

# Merge with current work
/handoff load merge
```
