# /handoff load

Read and restore work context from `.handoff/` directory.

## Usage

```
/handoff load [mode] [--focus TEXT] [--budget N] [--full]
```

## Modes

| Mode | Behavior |
|------|----------|
| (default) | Read context and summarize |
| `auto` | Auto-infer next steps based on state |
| `merge` | Merge with current working context |

## Options (Context Compiler)

The compiler flags require a readable Context Map. Compilation is strictly read-only and deterministic; without compiler flags the output carries no compiler diagnostics.

| Flag | Behavior |
|------|----------|
| `--focus TEXT` | Compile the map down to nodes relevant to TEXT. Current Goal and Current Status (with their ancestors) are always kept; other nodes are selected by normalized keyword-overlap scoring. |
| `--budget N` | Estimated token limit for the compiled map. Default `4000`, minimum `512`; lower or non-numeric values are rejected with an error. |
| `--full` | Return the entire map; overrides `--focus` and `--budget`. |

**Fallback safety:** when no non-core node matches the focus reliably, the full map is returned and a `Fallback:` reason is reported. Focused load never omits core state.

When any compiler flag is used, the output appends a deterministic diagnostics block:

```
Context compiler:
  Focus: wire the docs
  Budget: 4000 estimated tokens
  Selected: goal[0], status[0], tasks[0], knowledge[0]
  Omitted: 0 node(s)
  Estimated tokens: 31
  Overflow: no
  Fallback: no non-core node matched the focus reliably; returned the full map
```

## Pre-Flight Checks

Before loading, the script must:

### 1. Check Storage Configuration

Read `.handoff.config.json` from project root.

**If found:** validate it before loading (v1.5.1). The file is portable project configuration: absolute paths, home-relative paths, parent traversal, and credential-like values are rejected everywhere except `storage.remote` (existing submodule URLs stay supported). If validation fails, report each error and stop instead of loading.

**If not found:** Fall back to direct mode behavior (assume `.handoff/` is a local directory).

### 2. Validate Storage Mode

**direct mode:**
- Check `.handoff/` exists
- If missing: "No handoff context found. Run `/handoff save` first."

**submodule mode:**
- Verify `.handoff` is registered as a git submodule
- If not initialized, run:

```bash
git submodule update --init --recursive .handoff
```

- If initialization fails:

```
Unable to initialize .handoff submodule.

This may be a private repository. Please make sure your SSH key
or GitHub credentials have access to the remote repository.
```

- If `.handoff/` directory is empty after init attempt:

```
The .handoff submodule could not be populated.

Possible causes:
1. The remote repository does not exist
2. Your SSH key or credentials lack access
3. Network connectivity issue

Run: git submodule update --init --recursive .handoff
to retry initialization.
```

## Execution Steps

### 1. Read .handoff/ Contents

Check for:
- `.handoff/context-map.md` (canonical semantic source, v2)
- `.handoff/context.json`
- `.handoff/HANDOFF.md` (generated view in v2; authored file in legacy 1.x)
- `.handoff/tasks.md`, `.handoff/decisions.md` (generated views in v2)

### 2. Parse Files

#### Parse context-map.md (first, when present)

The Context Map is the semantic source of the handoff. Extract:
- Current Goal, Current Status
- Tasks (checkbox state → pending/completed, `**priority**` markers)
- Decisions, Risks, Knowledge and Notes
- Open Questions, Excluded (retained in the map; not shown in the summary)

Section headings may be localized; an internal label mapping resolves them to the fixed semantic keys.

If the map is **absent, empty, or malformed** (no recognized semantic section), fall back to the legacy path below unchanged — old 1.x four-file handoffs load without migration. For a **v2 handoff whose map is missing**, fall back to the generated `HANDOFF.md` view.

#### Parse context.json

In v2, `context.json` carries no semantic fields — only protocol metadata (version, timestamp, agent, project, lang), Git state, SHA-256 hashes of the generated views, and migration/conflict diagnostics. It supplements the map with machine state (git branch/commit, timestamps).

For legacy 1.x handoffs, `context.json` additionally supplies any semantic field the map leaves empty (current_goal, status, todos, decisions, risks, notes). For map-only handoffs (no valid `context.json`), the map alone drives the summary. For mixed-format handoffs, map semantics win over `context.json` semantics.

#### View tamper and migration warnings

- The on-disk views are hashed and compared against the hashes stored in `context.json`. A mismatch warns: the view was manually edited, but it is generated from `context-map.md` — edit the map instead. Manual view edits are never imported and are overwritten on the next save; semantics still come from the map.
- A legacy pre-v2 handoff loads read-only and prints a note that `/handoff save` will migrate it (originals are backed up under `.handoff/history/migrations/` automatically).

#### Parse HANDOFF.md (legacy fallback)

Only used when neither the map nor `context.json` is readable (legacy 1.x), or as the generated-view fallback for a v2 handoff with a missing map. Extract sections:
- Current Goal
- Current Status
- Completed Work
- Modified Files
- Outstanding Issues
- TODO
- Recommended Next Steps

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
1. Analyze blockers -> suggest resolutions
2. Analyze incomplete tasks -> prioritize
3. Check git state -> suggest sync if needed
4. Generate detailed action plan

Output includes:
- All default output
- Detailed action plan with rationale
- Stale handoff detection (>24h warning)
- An `Auto-analysis:` block (project, agent, last saved, modified files, branch)

#### merge - Context Merge

Merge handoff context with current state:

1. Load handoff context
2. Compare with current git state
3. Identify:
   - New changes since handoff
   - Branch mismatch
   - Uncommitted changes
4. Generate merged context

Output includes:
- `Sync with N new commit(s) since handoff` as the first recommended action when the current branch has commits the handoff predates
- A `Branch mismatch: handoff on '...', current on '...'` risk when branches differ
- Updated recommended actions

## Output Examples

### Standard Load

```
Storage: direct

Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting

Recommended next actions:
1. [HIGH] Add Redis backend for distributed rate limiting
2. Review 2 newly added file(s)
3. Address 2 medium-priority TODO items

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory

Pending tasks: 3
```

### Auto-Infer

```
Current understanding:
[as above]

Recommended next actions:
1. [HIGH] Add Redis backend for distributed rate limiting
2. Review 2 newly added file(s)
3. Address 2 medium-priority TODO items
4. Review and commit pending changes

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory
- Handoff is 36h old - may be stale

---
Auto-analysis:
  Project: my-api
  Agent: opencode
  Last saved: 2025-05-28T10:30:00.000Z
  Modified files: 3
  Branch: feature/rate-limiting
```

### Merge

```
Recommended next actions:
1. Sync with 3 new commit(s) since handoff
2. [HIGH] Add Redis backend for distributed rate limiting
...

Potential risks:
- Branch mismatch: handoff on 'feature/rate-limiting', current on 'main'
- Uncommitted changes in working directory
```

### Focused Load

```
Current understanding:
[as above]

Context compiler:
  Focus: vector database
  Budget: 4000 estimated tokens
  Selected: goal[0], status[0], tasks[0], excluded[0]
  Omitted: 5 node(s)
  Estimated tokens: 512
  Overflow: no
```

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `.handoff.config.json` | Fall back to direct mode |
| Invalid `.handoff.config.json` | Report each validation error and stop |
| No `.handoff/` | "No handoff context found" |
| Submodule not initialized | Run `git submodule update --init` |
| Submodule access denied | Clear error about SSH/credential access |
| Empty files | Warn, skip empty sections |
| context-map.md absent/empty/malformed | Fall back to context.json, then HANDOFF.md (v2: the HANDOFF.md view) |
| Generated view manually edited | Warn (hash mismatch); semantics still come from the map |
| Legacy pre-v2 handoff | Load read-only; note that `/handoff save` migrates with backup |
| Invalid JSON | Warn, use context-map.md or HANDOFF.md |
| Missing sections | Skip, note in output |
| `--budget` below 512 or non-numeric | Error: expected an integer >= 512 |
| `--focus` without a value | Error: `--focus requires a value` |
| Unknown flag | Error: unknown flag |

## Security

When displaying loaded context:
- Filter all sensitive patterns (API keys, tokens, passwords, etc.)
- Verify no secrets in output
- Warn if suspicious content detected

## Examples

```bash
# Standard load
/handoff load

# Get detailed action plan
/handoff load auto

# Merge with current work
/handoff load merge

# Load only what is relevant to the current task
/handoff load --focus "rate limiting middleware"

# Focused load with a tighter token budget
/handoff load --focus "rate limiting" --budget 2000

# Load the entire map explicitly
/handoff load --full
```
