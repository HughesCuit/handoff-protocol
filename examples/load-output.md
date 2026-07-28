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

Since v2, load reads `.handoff/context-map.md` first (the canonical semantic source: goal, status, tasks, decisions, risks) and supplements it with machine state from `context.json` (git, timestamps). Legacy 1.x handoffs without a map load unchanged through the original fallback, and print a read-only note that `/handoff save` will migrate them.

```
Storage: direct

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
Storage: direct

Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting middleware | Completed: 3 items | Branch: feature/rate-limiting | Pending tasks: 3

Recommended next actions:
1. Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
2. Add sliding window algorithm (src/middleware/rate-limiter.ts:78)
3. Update API documentation (docs/api.md:12)
4. [HIGH] Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
5. Address 2 medium-priority TODO items
6. Review and commit pending changes

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

Includes everything from default mode, plus commits-since-handoff and branch-mismatch detection:

```
Recommended next actions:
1. Sync with 2 new commit(s) since handoff
2. Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)
...

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory
- Branch mismatch: handoff on 'feature/rate-limiting', current on 'main'
```

## Focused Load (`--focus` / `--budget` / `--full`)

With compiler flags, the map is compiled down to relevant nodes (goal and status are always kept) and a deterministic diagnostics block is appended:

```
Storage: direct

Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting middleware | Branch: feature/rate-limiting | Pending tasks: 3

Recommended next actions:
1. [HIGH] Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)

Potential risks:
- 1 high-priority TODO/FIXME items pending

Pending tasks: 3

Context compiler:
  Focus: rate limiting
  Budget: 4000 estimated tokens
  Selected: goal[0], status[0], tasks[0], tasks[1], risks[0]
  Omitted: 2 node(s)
  Estimated tokens: 640
  Overflow: no
```

When no non-core node matches the focus reliably, the full map is returned with a reported reason:

```
Context compiler:
  Focus: zebra quokka
  Budget: 4000 estimated tokens
  Selected: goal[0], status[0], tasks[0], tasks[1], tasks[2], decisions[0], risks[0]
  Omitted: 0 node(s)
  Estimated tokens: 980
  Overflow: no
  Fallback: no non-core node matched the focus reliably; returned the full map
```

`--full` selects the entire map and overrides `--focus`/`--budget`.

## View Tamper Warning

If a generated view was manually edited, load warns (stderr) and still takes semantics from the map:

```
Warning: tasks.md was manually edited, but it is generated from context-map.md. Edit context-map.md instead — manual view changes are never imported and are overwritten on save.
```

## Legacy Migration Note

Legacy pre-v2 handoffs load read-only and print (stderr):

```
Note: legacy handoff format (pre-v2) detected. Run `/handoff save` to migrate to v2; originals are backed up under .handoff/history/migrations/ automatically.
```

## Fallback: HANDOFF.md Parsing

If `context-map.md` and `context.json` are missing or corrupted, the script falls back to parsing `HANDOFF.md` (for a v2 handoff with a missing map, the generated `HANDOFF.md` view serves the same role):

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
Error: No readable context found in .handoff/ (checked context-map.md, context.json, HANDOFF.md)
Run `/handoff save` to regenerate the handoff files.

Current understanding:
Handoff directory exists but contains no readable context.
```
