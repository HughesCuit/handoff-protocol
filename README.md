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
- **Flexible Storage**: Direct mode for private repos, submodule mode for public repos
- **Simple**: Works via prompt alone, scripts optional (Deno + Node.js)

## Quick Start

```bash
# Initialize storage (first time only)
/handoff init direct       # for private repos
/handoff init submodule    # for public repos

# Save current work context
/handoff save

# Save in specific language with verbosity
/handoff save --lang zh --verbosity high

# Load context and continue
/handoff load
```

## Storage Modes

Handoff Protocol supports two storage modes for `.handoff/`:

### direct

Stores `.handoff/` directly in the current project directory.

**Best for:**
- Private repositories
- Local-only projects
- Personal projects
- Teams that intentionally version handoff context with the codebase

**Config (`.handoff.config.json`):**
```json
{
  "version": "1.2.0",
  "storage": {
    "mode": "direct",
    "path": ".handoff"
  }
}
```

### submodule

Stores `.handoff/` as a Git submodule pointing to a separate private repository.

**Best for:**
- Public repositories
- Open-source projects
- Projects where handoff context should remain private
- Teams that want to separate source code history from agent context history

**Why submodule for public repos?**

In public repositories, `.handoff/` may contain:
- Private context and implementation notes
- Local paths and environment details
- Task history and unfinished plans
- Architecture reasoning and design decisions
- Sensitive operational details

Submodule mode keeps this data in a separate private repository while maintaining a clean reference in the public project.

**Config (`.handoff.config.json`):**
```json
{
  "version": "1.2.0",
  "storage": {
    "mode": "submodule",
    "path": ".handoff",
    "remote": "git@github.com:USER/PROJECT-handoff.git"
  }
}
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
| `/handoff init` | Interactive storage mode selection |
| `/handoff init direct` | Initialize direct storage mode |
| `/handoff init submodule` | Initialize submodule storage mode |
| `/handoff storage` | Display current storage configuration |
| `/handoff save` | Save current context (standard mode) |
| `/handoff save compact` | Save minimal summary |
| `/handoff save full` | Save maximum context |
| `/handoff save diff` | Save with focus on code changes |
| `/handoff save --lang CODE` | Save with specific language (zh, en, ja, etc.) |
| `/handoff save --verbosity LEVEL` | Save with detail level (low, med, high) |
| `/handoff load` | Load and summarize |
| `/handoff load auto` | Load with auto-inference |
| `/handoff load merge` | Load and merge with current git state |

## How It Works

### First Time Setup

```bash
# Choose storage mode
/handoff init

# Or specify directly
/handoff init direct
/handoff init submodule   # will prompt for private repo URL
```

### Save

When you run `/handoff save`, the skill:

1. Reads `.handoff.config.json` for storage mode
2. For submodule: ensures submodule is initialized
3. Collects git state (status, diff, log)
4. Scans codebase for TODO/FIXME comments
5. Infers current goal from recent commits
6. Generates `.handoff/` files
7. For submodule: commits and pushes to submodule repo

### Language & Verbosity

The save command supports two additional options:

- **`--lang CODE`**: Controls the language of generated content (e.g., `zh` for Chinese, `en` for English). When omitted, follows the conversation language automatically.
- **`--verbosity LEVEL`**: Controls detail level — `low` (minimal), `med` (standard, default), `high` (maximum detail with extended analysis).

```bash
# Chinese output with minimal detail
/handoff save --lang zh --verbosity low

# English output with maximum detail
/handoff save full --lang en --verbosity high
```

### Load

When you run `/handoff load`, the skill:

1. Reads storage configuration
2. For submodule: initializes submodule if needed
3. Reads `.handoff/` contents (falls back to HANDOFF.md if context.json missing)
4. Sanitizes output (security filtering)
5. Generates recommended next actions

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
```

See [examples/](examples/) for full sample outputs.

## Security

All outputs are automatically filtered for:
- API keys and tokens (generic, GitHub `ghp_*`, GitLab `glpat-*`)
- AWS access keys (`AKIA*`)
- Bearer tokens and JWT tokens
- Passwords and private keys (PEM, SSH)
- Connection strings with credentials
- Cloud service credentials (GCP, Azure, OpenAI)
- OAuth tokens

**Security filtering applies regardless of storage mode.** Submodule mode reduces public exposure risk but does not permit saving secrets.

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
