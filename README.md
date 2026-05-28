# Handoff Protocol

Cross-agent context handoff protocol for AI coding agents.

## What is this?

Handoff Protocol is a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

It manages a `.handoff/` directory - the Agent Context Protocol equivalent of `.git/` for AI agent collaboration.

## Quick Start

```bash
# Save current work context
/handoff save

# Load context and continue
/handoff load
```

## Installation

Copy the `skills/handoff/` directory to your project's skills folder.

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

## Documentation

- [Skill Documentation](skills/handoff/README.md)
- [Save Command](skills/handoff/commands/save.md)
- [Load Command](skills/handoff/commands/load.md)

## License

MIT
