# Example: Load Output

Below is an example of what `/handoff load` produces.

## Command

```bash
# Deno
deno run --allow-read --allow-run scripts/load.ts

# Node.js
node scripts/node/load.mjs
```

## Default Mode Output

```
Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting middleware | Completed: 3 items | Branch: feature/rate-limiting | Pending tasks: 3

Recommended next actions:
1. Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
2. Add sliding window algorithm (src/middleware/rate-limiter.ts:78)
3. Update API documentation (docs/api.md:12)
4. [HIGH] Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory

Pending tasks: 3
```

## Auto Mode Output

```
Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting middleware | Completed: 3 items | Branch: feature/rate-limiting | Pending tasks: 3

Recommended next actions:
1. Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
2. Add sliding window algorithm (src/middleware/rate-limiter.ts:78)
3. Update API documentation (docs/api.md:12)
4. [HIGH] Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
5. Review 2 newly added file(s)
6. Review changes to 1 modified file(s)
7. Address 2 medium-priority TODO items
8. Review and commit pending changes

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory

Pending tasks: 3

---
Auto-analysis:
  Project: my-api
  Agent: opencode
  Last saved: 2025-05-28T10:30:00.000Z
  Modified files: 3
  Branch: feature/rate-limiting
```

## Merge Mode Output

Includes everything from default mode, plus:

```
Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory
- Branch mismatch: handoff on 'feature/rate-limiting', current on 'main'
- New commits since handoff:
abc1234 feat: add rate limiting middleware
def5678 fix: resolve connection pool leak
- 5 file(s) have uncommitted changes

Recommended next actions:
1. Sync with 2 new commit(s) since handoff
2. Add Redis backend for distributed rate limiting
...
```

## Fallback: HANDOFF.md Parsing

If `context.json` is missing or corrupted, the script falls back to parsing `HANDOFF.md`:

```
Warning: context.json missing or invalid. Falling back to HANDOFF.md parsing.
Successfully parsed HANDOFF.md as fallback.

Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | ...
```

## Error Cases

### No .handoff/ directory

```
Error: No .handoff/ directory found.
Possible causes:
  1. Run `/handoff save` first to create context
  2. You may be in the wrong directory
  3. Expected path: /Users/dev/my-project/.handoff

Current understanding:
No handoff context found.

Recommended next actions:
1. Run `/handoff save` to create context
```

### Empty .handoff/ directory

```
Error: Neither context.json nor HANDOFF.md found in .handoff/
Run `/handoff save` to regenerate both files.

Current understanding:
Handoff directory exists but contains no readable context.
```
