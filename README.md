# Handoff Protocol

> Cross-agent context handoff protocol for AI coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is Handoff Protocol?

Handoff Protocol is a standardized way to save, restore, and share work context between different AI coding agents (OpenCode, Codex, Claude Code, OpenHands, Cursor Agent, etc.).

It manages a `.handoff/` directory - the **Agent Context Protocol** equivalent of `.git/` for AI agent collaboration.

> **Versioning note:** the protocol *schema* version (`protocolVersion` in `context.json`, `V3_PROTOCOL_VERSION` in `scripts/context-map.mjs`) tracks the `.handoff/` data format — it is `3.0.0` for the v3 line. The *product* release version (`package.json`, release tags) tracks feature releases.

Since v3, the Context Map is a **directory**: `.handoff/context-map.md` is a
compact semantic directory (stable node IDs, labels, hierarchy, task state),
and the full node bodies live in eight section files under `.handoff/content/`,
keyed by those IDs. `views/HANDOFF.md` is the only generated view (marked
`do not edit`), and `context.json` keeps only metadata, monotonic ID counters,
and SHA-256 file hashes — manual view edits warn and are never imported. Nested
Markdown list indentation expresses parent-child relationships, and
agent-generated nodes/entries carry a fingerprint, so direct edits automatically
become user-owned and survive later saves. v2 and legacy 1.x handoffs stay
readable; the first `/handoff save` migrates them automatically (see
[`docs/migrations/v2-to-v3.md`](docs/migrations/v2-to-v3.md)).

**v3 layout:**

```
.handoff/
  context-map.md          # directory: stable IDs, labels, hierarchy, state
  content/
    current-goal.md       # node bodies (summary + detail), keyed by stable ID
    current-status.md
    tasks.md
    decisions.md
    open-questions.md
    risks.md
    knowledge-notes.md
    excluded.md
  views/
    HANDOFF.md            # the only generated view (do not edit)
  context.json            # protocolVersion 3.0.0, ID counters, file hashes
  history/
    snapshots/
    migrations/           # sensitive-filtered backups of pre-migration originals
```

## Features

- **Cross-agent**: Core workflow verified on Codex, Claude Code, OpenCode, and Kimi Code CLI — see [Agent Compatibility](#agent-compatibility) for honest tiers
- **Standard**: Unix-style commands, machine-readable formats (JSON Schema)
- **Canonical Context Map** (v3): A compact directory (`context-map.md`) plus eight `content/` body files, keyed by stable node IDs — your edits win over agent inference, and the generated view makes tampering visible
- **Effort-aware Load**: `/handoff load --effort min|low|med|high|max --focus "current task"` compiles the directory + bodies down to relevant nodes, never omitting goal/status, and falls back to full context safely
- **Semantic Diff**: `/handoff diff` reports added/deleted/moved/label/summary/body/task-state/attribute changes by stable ID against bounded, sanitized snapshots
- **Safe Migration**: v2 and legacy 1.x / v1.5 handoffs migrate atomically to v3 on the next save, with sensitive-filtered backups, rollback, and no silent loss
- **Obsidian Adapter** (optional UI): Observe live `.handoff/` state from an Obsidian Vault via a link — the adapter never copies or owns project state
- **Secure**: Automatic sensitive data filtering (API keys, tokens, passwords, JWT, cloud credentials) before anything is persisted or displayed
- **Smart**: Auto-analyzes codebase comments for TODO/FIXME, infers goals from git history
- **Flexible Storage**: Direct mode for private repos, submodule mode for public repos
- **Simple**: Works via prompt alone, scripts optional (Deno + Node.js)

## Agent Compatibility

Handoff uses basic `SKILL.md` semantics — it does not require Claude-only hooks
or `context: fork`, so it runs in any host that supports basic skills,
filesystem access, and command execution.

| Tier | Agents | Claim |
|------|--------|-------|
| Core verified | Codex, Claude Code, OpenCode, Kimi Code CLI | Installation and the core handoff workflow are explicitly supported and used for release documentation. |
| Compatible | OpenHands, Cursor | Basic `SKILL.md`, filesystem, and shell workflow is supported; host UX may differ. |
| Skills CLI ecosystem | Other targets reported by the Skills CLI | Expected to work when the host supports basic skills, filesystem access, and command execution; not individually certified by this project. |

The Skills CLI's full, changing target list lives in the [official Skills CLI
repository](https://github.com/vercel-labs/skills); this project certifies only
the tiers above rather than copying every name.

`/handoff view` additionally requires Node.js and a host capable of opening or
presenting the returned loopback URL (for example a side browser or the system
browser).

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

# Load just what matters for the current task
/handoff load --focus "rate limiting" --budget 2000

# See what changed since the last snapshot
/handoff diff
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
  "version": "3.0.0",
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
  "version": "3.0.0",
  "storage": {
    "mode": "submodule",
    "path": ".handoff",
    "remote": "git@github.com:USER/PROJECT-handoff.git"
  }
}
```

### Configuration Validation

Since v1.5.1, `.handoff.config.json` is validated before every `init`, `save`, and `load`. The file is **portable project configuration**, so validation rejects:

- Absolute paths (`/Users/...`, `C:\...`)
- Home-relative paths (`~/...`, `$HOME/...`, `%USERPROFILE%\...`) and parent traversal (`../...`)
- Credential-like values (tokens, keys, passwords) anywhere in the file

The only exception is `storage.remote`, where existing submodule remote URLs (SSH or HTTPS) remain supported.

A config that passes validation contains no machine-specific paths and no secrets, so it is **safe and recommended to commit** alongside your project. If validation fails, fix the file or remove it and run `/handoff init` to reconfigure storage. (The Obsidian Vault path is deliberately stored in a user-level config, never here.)

## Installation

### Skills CLI (Recommended)

The fastest way to install the `handoff` skill is with the [Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add HughesCuit/handoff-protocol
```

The interactive CLI detects the supported agents on your machine and asks for the installation scope (project-level or global). Use `-y` to accept the defaults, or `-g` for a global (user-level) install.

Install for a specific agent:

```bash
npx skills add HughesCuit/handoff-protocol --agent codex
npx skills add HughesCuit/handoff-protocol --agent claude-code
npx skills add HughesCuit/handoff-protocol --agent opencode
npx skills add HughesCuit/handoff-protocol --agent kimi-code-cli
```

### npm package

For tooling that needs a version-locked copy of the protocol, Skill, scripts,
and Viewer assets without performing a global Agent installation:

```bash
npm install handoff-protocol
```

Installing the npm package only places these resources in `node_modules`.
Use the Skills CLI commands above when you want to install `handoff` into a
supported Agent host.

### Context Map Viewer

`/handoff view` opens the current project's `.handoff/context-map.md` as a live,
read-only mind map with Tree/Map/Both modes, search, folding, pan, zoom, and
long-node details. It has no MCP App or plugin dependency; it works wherever the
core handoff workflow runs (see [Agent Compatibility](#agent-compatibility)),
provided the host can open or present the returned loopback URL.

```text
/handoff view
/handoff view --idle-minutes 60
/handoff view --json
```

The command starts or reuses one user-level local Viewer daemon and returns a
temporary, token-scoped loopback URL for the current project. **The agent, not
the command, decides how to open that URL** — in a side browser, system browser,
external browser, or simply presented to you. The URL listens only on
`127.0.0.1` at a random port, is scoped by an opaque token, and exists only in
memory; do not copy, persist, reconstruct, or reuse it in another task. The
viewer polls for updates every 750 ms and expires after its own idle deadline
(default 30 minutes, configurable 1–1440). If it has expired, run `/handoff
view` again for a new URL. The daemon auto-shuts-down when no sessions remain;
it is not a permanent service. This presentation layer is read-only and does not
change the Handoff storage format or modify Handoff state.

> **Note:** The standalone `context-map-viewer` Codex plugin (final release
> `0.2.0`) has been replaced by this host-independent `/handoff view` command as
> of Handoff Protocol v2.4.0. Codex users should remove
> `context-map-viewer@handoff-protocol`; no plugin, MCP, or Marketplace setup is
> required anymore.

### Manual installation

For pinned, offline, or unsupported-host setups, install the skill manually.

#### Project-Level Install (clone + symlink)

Clone the repo into your project, then run the install script. It creates symlinks so all supported agents share the same skill — no per-agent duplication.

```bash
# From your project root:
git clone https://github.com/HughesCuit/handoff-protocol.git
bash handoff-protocol/install.sh
```

This creates symlinks in your project directory:

```
your-project/
  .opencode/skills/handoff -> handoff-protocol/   (OpenCode)
  .claude/skills/handoff   -> handoff-protocol/   (Claude Code)
  .mimocode/skills/handoff -> handoff-protocol/   (MimoCode)
```

To uninstall: `bash handoff-protocol/uninstall.sh`

> **Tip:** Add `handoff-protocol/` as a git submodule if you want to pin a specific version across your team.

#### Global Install (All Projects)

If you prefer a one-time global install instead of per-project:

##### Codex

```bash
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo HughesCuit/handoff-protocol --path . --name handoff
```

##### OpenCode / Claude Code

```bash
git clone https://github.com/HughesCuit/handoff-protocol.git ~/.opencode/skills/handoff
git clone https://github.com/HughesCuit/handoff-protocol.git ~/.claude/skills/handoff
```
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
| `/handoff load --focus TEXT` | Load only map nodes relevant to TEXT (goal/status always kept) |
| `/handoff load --budget N` | Cap the compiled map at N estimated tokens (default 4000, min 512) |
| `/handoff load --full` | Load the entire map (overrides --focus/--budget) |
| `/handoff adapter obsidian link --vault PATH [--alias NAME]` | Link `.handoff/` into an Obsidian Vault |
| `/handoff adapter obsidian status` | Show adapter link state |
| `/handoff adapter obsidian unlink` | Remove only the adapter-created link |
| `/handoff diff [--from latest\|SNAPSHOT_ID] [--format markdown\|json]` | Semantic diff of the map against a snapshot |
| `/handoff view [--idle-minutes N] [--json]` | Open the Context Map as a live mind map via a local Viewer daemon URL (agent opens it) |

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
3. Detects the layout; migrates pre-v3 (v2 or legacy 1.x / v1.5) handoffs atomically to v3 (originals backed up under `.handoff/history/migrations/`)
4. Collects git state (status, diff, log)
5. Scans codebase comments for TODO/FIXME
6. Reconciles the canonical v3 state — directory (`context-map.md`) plus the eight `content/` body files — preserving your edits and allocating stable IDs only for genuinely new nodes (a goal is never inferred from commits)
7. Atomically writes `context-map.md`, `content/`, `views/HANDOFF.md`, and `context.json` (metadata + ID counters + file hashes)
8. Writes a bounded, sanitized snapshot under `.handoff/history/snapshots/` when the semantic state changed
9. For submodule: commits and pushes to submodule repo

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
3. Reads the canonical v3 state — the `context-map.md` directory plus the `content/` bodies — supplemented by machine state from `context.json` (falls back to `views/HANDOFF.md`, then legacy `context.json`/`HANDOFF.md` for v2 / 1.x handoffs)
4. Warns about a manually edited generated view and pre-v3 formats pending migration
5. With `--effort min|low|med|high|max` (default `med`) and `--focus`/`--budget`, compiles the directory + bodies down to relevant nodes — core goal/status is never omitted, an explicit budget degrades bodies → summaries → directory-only with reported steps, and an unreliable focus falls back to the full map with a reported reason
6. Sanitizes output (security filtering)
7. Generates recommended next actions

### Migration Backup & Recovery

v2 and legacy 1.x / v1.5 handoffs load read-only; the first `/handoff save` migrates them to the v3 directory layout automatically (see [`docs/migrations/v2-to-v3.md`](docs/migrations/v2-to-v3.md)):

- Migration is **atomic**: outputs are written through temporary files, originals (including `.handoff.config.json`) are backed up to `.handoff/history/migrations/<UTC-timestamp>/`, and renames happen only after validation — the config version upgrade (`3.0.0`) renames last, and the old root `HANDOFF.md`/`tasks.md`/`decisions.md` are retired. If any rename fails mid-phase, every file already replaced is rolled back, leaving the originals byte-identical.
- Backups are **sensitive-data filtered**: if an old file contained credential-like content, its backup holds the filtered text, not the original bytes.
- Migration is **idempotent**: an already-v3 handoff is never re-migrated and creates no second backup.
- Every migrated node receives a **stable ID**; the complete original text becomes the body summary. **Do not** manually copy old root `tasks.md`/`decisions.md` into `content/`.
- Conflicting values are never silently dropped — superseded goal/status values stay visible under Open Questions → "Migration conflict", labeled with their source file.

### Obsidian Adapter (Optional UI)

`/handoff adapter obsidian link --vault /path/to/vault` makes `.handoff/` browsable in Obsidian as `<Vault>/Projects/<alias>`, plus a `Handoff Projects.md` index note. Obsidian is an **optional UI Adapter, not a storage authority**: nothing is copied into the Vault, the adapter never owns project state, and `unlink` removes only the adapter-created link — it cannot delete user data. The Vault path lives in user-level config (`$XDG_CONFIG_HOME/handoff/config.json` or `%APPDATA%/handoff/config.json`), never in the portable project config.

## Scripts

Two runtimes supported:

```bash
# Deno (recommended)
deno run --allow-read --allow-write --allow-run --allow-env scripts/save.ts
deno run --allow-read --allow-run scripts/load.ts
deno run --allow-read --allow-write --allow-env scripts/adapter.ts obsidian link --vault /path/to/vault
deno run --allow-read scripts/diff.ts

# Node.js
node scripts/node/save.mjs
node scripts/node/load.mjs
node scripts/node/adapter.mjs obsidian link --vault /path/to/vault
node scripts/node/diff.mjs
```

Both runtimes share the runtime-agnostic ESM core under `scripts/` (`context-map.mjs`, `content-files.mjs`, `handoff-state.mjs`, `views.mjs`, `migrate.mjs`, `migrate-v3.mjs`, `context-compiler.mjs`, `snapshots.mjs`, `context-diff.mjs`, `config.mjs`, `source-comments.mjs`, `adapters/obsidian.mjs`) so behavior is identical.

## Tests

Fixture-based tests verify both runtimes against the same fixtures (`tests/fixtures/`):

```bash
# Deno
deno test --allow-read --allow-write --allow-run --allow-env tests/deno/

# Node.js
node --test "tests/node/**/*.test.mjs"
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

Filtering applies before anything is persisted or displayed — handoff files, the Context Map, snapshots, migration backups, the Obsidian index, and diff output. **Security filtering applies regardless of storage mode.** Submodule mode reduces public exposure risk but does not permit saving secrets.

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
