# Handoff Protocol

> Cross-agent context handoff protocol for AI coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Handoff Protocol?

Handoff Protocol is a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

It manages a `.handoff/` directory - the **Agent Context Protocol** equivalent of `.git/` for AI agent collaboration.

## Features

- **Universal**: Works across OpenCode, Codex, Claude Code, OpenHands, Cursor Agent
- **Standard**: Unix-style commands, machine-readable formats (JSON Schema)
- **Secure**: Automatic sensitive data filtering (API keys, tokens, passwords, JWT, cloud credentials)
- **Smart**: Auto-analyzes codebase for TODO/FIXME, infers goals from git history
- **Simple**: Works via prompt alone, scripts optional (Deno + Node.js)

## Quick Start

```bash
# Save current work context
/handoff save

# Load context and continue
/handoff load
```

## Installation

### For OpenCode

```bash
git clone https://github.com/HughesCuit/handoff-protocol.git ~/.opencode/skills/handoff-protocol
```

### For Claude Code

```bash
git clone https://github.com/HughesCuit/handoff-protocol.git ~/.claude/skills/handoff-protocol
```

### For Other Agents

See [Agent Skills Specification](https://agentskills.io/specification) for installation paths.

## Commands

| Command | Description |
|---------|-------------|
| `/handoff save` | Save current context (standard mode) |
| `/handoff save compact` | Save minimal summary (goal + status + next steps) |
| `/handoff save full` | Save maximum context (20 commits, 50 TODOs, risk analysis) |
| `/handoff save diff` | Save with focus on code changes |
| `/handoff load` | Load and summarize |
| `/handoff load auto` | Load with auto-inference (detailed action plan) |
| `/handoff load merge` | Load and merge with current git state |

## How It Works

### Save

When you run `/handoff save`, the skill:

1. Collects git state (status, diff, log)
2. **Scans codebase for TODO/FIXME comments**
3. **Infers current goal from recent commits**
4. **Analyzes risk factors** (high-priority items, untracked files)
5. Generates `.handoff/HANDOFF.md` (human-readable)
6. Generates `.handoff/context.json` (machine-readable)
7. Generates `.handoff/tasks.md` (pending work)
8. Generates `.handoff/decisions.md` (architecture decisions)

### Load

When you run `/handoff load`, the skill:

1. Reads `.handoff/` contents (falls back to HANDOFF.md if context.json missing)
2. Parses and summarizes current state
3. Sanitizes output (security filtering)
4. Generates recommended next actions

## Scripts

Two runtimes supported:

```bash
# Deno (recommended)
deno run --allow-read --allow-write --allow-run scripts/save.ts
deno run --allow-read --allow-run scripts/load.ts

# Node.js
node scripts/node/save.mjs
node scripts/node/load.mjs
```

## Output Format

```
Current understanding:
Project: my-api | Status: in-progress - 3 file(s) modified | Goal: feat: add rate limiting

Recommended next actions:
1. [HIGH] Add Redis backend for distributed rate limiting
2. Review 2 newly added file(s)
3. Address 2 medium-priority TODO items

Potential risks:
- 1 high-priority TODO/FIXME items pending
- Uncommitted changes in working directory
```

See [examples/](examples/) for full sample outputs.

## Auto-Analysis

The save script automatically:

- **Extracts TODO/FIXME** from source files (with file:line references)
- **Infers current goal** from recent git commits
- **Determines status** from git working state
- **Identifies risks** (high-priority items, untracked files, stale handoffs)
- **Filters sensitive data** (API keys, tokens, JWT, AWS keys, connection strings)

## Security

All outputs are automatically filtered for:
- API keys and tokens (generic, GitHub `ghp_*`, GitLab `glpat-*`)
- AWS access keys (`AKIA*`)
- Bearer tokens and JWT tokens
- Passwords and private keys (PEM format)
- Connection strings with credentials
- Cookie headers

## Multi-Agent Collaboration

Different agents can collaborate through the `.handoff/` directory:

```
Agent A                    Agent B
    │                         │
    │  /handoff save          │
    │─────► .handoff/ ◄──────│
    │                         │  /handoff load
    │                         │───────► Continue work
```

## Documentation

- [SKILL.md](SKILL.md) - Main skill definition
- [Save Command](references/save.md) - Save command specification
- [Load Command](references/load.md) - Load command specification
- [Save Example](examples/save-output.md) - Sample save output
- [Load Example](examples/load-output.md) - Sample load output

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details.
