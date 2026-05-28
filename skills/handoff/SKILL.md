# Handoff Protocol Skill

Cross-agent context handoff protocol. Save and restore work context across AI coding agents.

## Overview

The Handoff Protocol provides a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

When invoked, the skill manages a `.handoff/` directory that serves as the Agent Context Protocol - similar to `.git/` for version control, but for AI agent collaboration.

## Commands

### /handoff save [mode]

Save current work context to `.handoff/`.

**Modes:**
- (default) - Standard save with current state
- `compact` - Minimal summary only
- `full` - Maximum context with all details
- `diff` - Focus on code changes

**Execution:**
1. Run `git status`, `git diff --stat`, `git log --oneline -5`
2. Analyze current work state
3. Generate `.handoff/HANDOFF.md` (human-readable)
4. Generate `.handoff/context.json` (machine-readable)
5. Generate `.handoff/tasks.md` (pending work)
6. Generate `.handoff/decisions.md` (architecture decisions)

### /handoff load [mode]

Read and restore context from `.handoff/`.

**Modes:**
- (default) - Standard read and summarize
- `auto` - Auto-infer next steps
- `merge` - Merge with current context

**Execution:**
1. Read `.handoff/` contents
2. Parse HANDOFF.md and context.json
3. Summarize current state
4. Generate recommended next actions

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
- API keys, tokens, secrets
- Bearer tokens, cookies
- Passwords, private keys
- .env contents

Nothing sensitive is written to `.handoff/`.

## Directory Structure

```
.handoff/
  HANDOFF.md      # Human-readable context
  context.json    # Machine-readable state
  tasks.md        # Pending tasks
  decisions.md    # Architecture decisions
```

## Template Reference

See templates for output format:
- `templates/HANDOFF.template.md`
- `templates/context.template.json`

## Command Details

For full command specifications:
- `commands/save.md`
- `commands/load.md`

## Scripts

Enhanced functionality (optional):
- `scripts/save.ts`
- `scripts/load.ts`

The skill works purely via prompt - scripts provide additional capabilities when available.

## Multi-Agent Usage

Different agents can collaborate through the `.handoff/` directory:

1. Agent A runs `/handoff save`
2. Agent B runs `/handoff load`
3. Agent B continues work with full context

The protocol is agent-agnostic - any compliant agent can read/write the same format.
