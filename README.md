# Handoff Protocol

> Cross-agent context handoff protocol for AI coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Handoff Protocol?

Handoff Protocol is a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

It manages a `.handoff/` directory - the **Agent Context Protocol** equivalent of `.git/` for AI agent collaboration.

## Features

- **Universal**: Works across OpenCode, Codex, Claude Code, OpenHands, Cursor Agent
- **Standard**: Unix-style commands, machine-readable formats
- **Secure**: Automatic sensitive data filtering (API keys, tokens, passwords)
- **Simple**: Works via prompt alone, scripts optional

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
# Clone to OpenCode skills directory
git clone https://github.com/handoff-protocol/handoff-protocol.git ~/.opencode/skills/handoff-protocol
```

### For Claude Code

```bash
# Clone to Claude skills directory
git clone https://github.com/handoff-protocol/handoff-protocol.git ~/.claude/skills/handoff-protocol
```

### For Other Agents

See [Agent Skills Specification](https://agentskills.io/specification) for installation paths.

## Commands

| Command | Description |
|---------|-------------|
| `/handoff save` | Save current context |
| `/handoff save compact` | Save minimal summary |
| `/handoff save full` | Save maximum context |
| `/handoff save diff` | Save with focus on changes |
| `/handoff load` | Load and summarize |
| `/handoff load auto` | Load with auto-inference |
| `/handoff load merge` | Load and merge with current |

## How It Works

### Save

When you run `/handoff save`, the skill:

1. Collects git state (status, diff, log)
2. Analyzes current work state
3. Generates `.handoff/HANDOFF.md` (human-readable)
4. Generates `.handoff/context.json` (machine-readable)
5. Generates `.handoff/tasks.md` (pending work)
6. Generates `.handoff/decisions.md` (architecture decisions)

### Load

When you run `/handoff load`, the skill:

1. Reads `.handoff/` contents
2. Parses HANDOFF.md and context.json
3. Summarizes current state
4. Generates recommended next actions

## Output Format

```
Current understanding:
[concise summary of project state]

Recommended next actions:
[actionable next steps]

Potential risks:
[known blockers or risks]
```

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details.
