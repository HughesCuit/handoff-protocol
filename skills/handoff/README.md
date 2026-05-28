# Handoff Protocol

Cross-agent context handoff protocol for AI coding agents.

## Design Goals

- **Universal**: Works across OpenCode, Codex, Claude Code, OpenHands, Cursor Agent
- **Standard**: Unix-style commands, machine-readable formats
- **Secure**: Automatic sensitive data filtering
- **Simple**: Works via prompt alone, scripts optional

## Overview

The Handoff Protocol manages a `.handoff/` directory - the Agent Context Protocol equivalent of `.git/`. It enables seamless context transfer between different AI coding agents.

```
Agent A                    Agent B
    │                         │
    │  /handoff save          │
    │─────► .handoff/ ◄──────│
    │                         │  /handoff load
    │                         │───────► Continue work
```

## Commands

### `/handoff save [mode]`

Save current work context.

| Mode | Description |
|------|-------------|
| (default) | Standard save |
| `compact` | Minimal summary |
| `full` | Maximum context |
| `diff` | Focus on changes |

### `/handoff load [mode]`

Load and restore context.

| Mode | Description |
|------|-------------|
| (default) | Read and summarize |
| `auto` | Auto-infer next steps |
| `merge` | Merge with current state |

## File Structure

### Skill Files

```
skills/handoff/
├── SKILL.md                    # Skill definition
├── README.md                   # This file
├── commands/
│   ├── save.md                 # Save command spec
│   └── load.md                 # Load command spec
├── templates/
│   ├── HANDOFF.template.md     # Output template
│   └── context.template.json   # JSON schema
└── scripts/
    ├── save.ts                 # Enhanced save
    └── load.ts                 # Enhanced load
```

### Project Output

```
.handoff/
├── HANDOFF.md      # Human-readable context
├── context.json    # Machine-readable state
├── tasks.md        # Pending tasks
└── decisions.md    # Architecture decisions
```

## Usage Examples

### Basic Workflow

```bash
# Agent A: Save context before switching
/handoff save

# Agent B: Load context and continue
/handoff load
```

### Status Update

```bash
# Quick status for handoff
/handoff save compact

# Get detailed action plan
/handoff load auto
```

### Code Review Handoff

```bash
# Focus on changes
/handoff save diff

# Review with merge analysis
/handoff load merge
```

## Multi-Agent Collaboration

Different agents can collaborate through `.handoff/`:

1. **OpenCode** saves context
2. **Claude Code** loads and continues
3. **Codex** loads and reviews

The protocol is agent-agnostic - any compliant agent can read/write the same format.

## Security

All outputs automatically filter:
- API keys and tokens
- Bearer tokens and cookies
- Passwords and private keys
- `.env` contents

No sensitive data is written to `.handoff/`.

## Scripts (Optional)

Enhanced functionality when Deno available:

```bash
# Enhanced save
deno run --allow-read --allow-write --allow-run scripts/save.ts full

# Enhanced load with auto-inference
deno run --allow-read --allow-run scripts/load.ts auto
```

Scripts work alongside prompt-based execution.

## Integration

### With MCP

The `context.json` format is designed for MCP integration:

```json
{
  "project": "my-api",
  "current_goal": "Add rate limiting",
  "status": "in-progress",
  "next_steps": ["Implement limiter", "Add tests"]
}
```

### With CI/CD

```yaml
# Save context in CI
- run: deno run --allow-read --allow-write --allow-run skills/handoff/scripts/save.ts compact

# Load in next step
- run: deno run --allow-read --allow-run skills/handoff/scripts/load.ts
```

## Future Extensions

Planned commands (not yet implemented):

- `/handoff export` - Export to external format
- `/handoff import` - Import from external source
- `/handoff push` - Push to remote storage
- `/handoff pull` - Pull from remote storage
- `/handoff diff` - Compare contexts
- `/handoff inspect` - Detailed context inspection

## Best Practices

1. **Save before switching**: Always save context before changing agents
2. **Use appropriate mode**: `compact` for quick updates, `full` for complex handoffs
3. **Review before loading**: Check what changed since last save
4. **Keep clean**: Periodically clean old `.handoff/` data
5. **Commit context**: Include `.handoff/` in version control for team collaboration

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No `.handoff/` directory | Run `/handoff save` first |
| Invalid context.json | Re-run `/handoff save` to regenerate |
| Missing git info | Ensure git is available and initialized |
| Secrets in output | Report issue - filtering should prevent this |

## License

MIT
