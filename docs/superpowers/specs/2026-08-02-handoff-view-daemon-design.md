# Handoff View Daemon Design

**Date:** 2026-08-02

**Status:** Approved design

## Summary

Handoff Protocol will provide a host-independent `/handoff view` command that
starts or reuses one user-level local Viewer daemon and returns a temporary,
token-scoped Web URL for the current project's `.handoff/context-map.md`.
The Agent, not the command, decides how to open that URL. This replaces the
Codex-only `context-map-viewer` plugin and makes the existing Viewer available
to Codex, Claude Code, OpenCode, terminal Agents, and other hosts without an MCP
App or plugin dependency.

The first release is Node.js-only, read-only, loopback-only, and does not change
the Handoff data format. It is planned for Handoff Protocol v2.4.0.

## Goals

- Add `/handoff view [--idle-minutes N] [--json]` to the main Handoff Skill.
- Start or reuse one Viewer daemon per operating-system user.
- Create a new cryptographically random Viewer token on every invocation.
- Serve multiple projects concurrently without allowing a session to change or
  inspect another project's root.
- Return a URL that any Agent can open using its native browser capability or
  present to the user.
- Preserve the current Tree / Map / Both UI, live refresh, navigation, details,
  accessibility, and responsive behavior.
- Remove the Codex plugin, Marketplace entry, MCP server, MCP tools, and
  plugin-specific release lifecycle.
- Ship the Viewer as part of the main Handoff Protocol package and version it
  with Handoff Protocol from v2.4.0 onward.

## Non-goals

- Opening a browser directly from the CLI.
- Supporting Deno as a Viewer runtime in the first release.
- Listening on a LAN address or exposing a remotely accessible Viewer.
- Editing the Context Map through the Viewer.
- Adding a database, persistent session registry, service manager, or permanent
  daemon installation.
- Changing `.handoff/`, `context-map.md`, or the v2 schema.
- Keeping the Codex plugin as an adapter or compatibility package.

## Public Interface

### Skill command

```text
/handoff view [--idle-minutes N] [--json]
```

The Skill resolves the current project root exactly as `save` and `load` do,
then invokes the Node reference implementation.

### Node entry point

```text
node scripts/node/view.mjs [--idle-minutes N] [--json]
```

- `--idle-minutes N` sets the new Viewer session's idle expiry. The default is
  `30`; accepted values are integers from `1` through `1440` inclusive.
- `--json` emits exactly one JSON object on stdout. Diagnostics go to stderr.
- Unknown flags, missing values, non-integers, and out-of-range values fail
  without starting or mutating daemon state.

Successful human-readable output:

```text
Context Map Viewer ready.
URL: http://127.0.0.1:<port>/session/<token>/
Expires after: <N> minutes idle
```

Successful JSON output:

```json
{
  "status": "ready",
  "url": "http://127.0.0.1:<port>/session/<token>/",
  "sessionId": "opaque-safe-id",
  "source": ".handoff/context-map.md",
  "idleMinutes": 30,
  "daemonReused": true
}
```

The Agent extracts the URL and chooses whether to open it in a side browser,
system browser, external browser, or merely present it to the user.

### Deno behavior

The Deno-facing command documentation and dispatcher recognize `view`, but do
not implement a second server. They return the stable error
`VIEW_REQUIRES_NODE` with an actionable Node command. Existing Deno behavior
for every other Handoff command remains unchanged.

## Architecture

```text
Agent
  |
  | /handoff view
  v
scripts/node/view.mjs
  |- validate args and project root
  |- acquire/startup coordination
  |- discover and health-check daemon
  |- request a project-bound session
  `- print URL
          |
          v
User-level Viewer daemon (one per user)
  |- loopback HTTP listener on an OS-assigned port
  |- authenticated control plane
  |- project-keyed Context Stores
  |- token-keyed Viewer sessions
  `- automatic shutdown when no sessions remain
          |
          v
Agent-selected browser surface
```

One daemon may host sessions for several projects. Each project is identified
by its canonical real path and owns a separate Context Store and watcher. A
Viewer session stores an immutable reference to exactly one project store.
Neither Viewer URLs nor browser requests can supply, replace, or enumerate a
project path.

## Components and Code Layout

```text
viewer/
  web/
    app.mjs
    model.mjs
    transports.mjs
    standalone.html
    styles.css
  runtime/
    constants.mjs
    context-map-parser.mjs
    context-source.mjs
    context-store.mjs
    session-manager.mjs
    daemon-server.mjs
    daemon-state.mjs
    daemon-main.mjs
  scripts/
    build.mjs
  dist/
    index.html
    app.mjs
    model.mjs
    styles.css

scripts/
  node/
    view.mjs
  view.ts
```

### `scripts/node/view.mjs`

Owns command parsing and orchestration only. It validates the current project,
finds or starts the daemon, requests a session over the authenticated control
API, and formats output. It never reads Context Map content itself and never
opens a browser.

### `viewer/runtime/daemon-state.mjs`

Owns the user runtime directory, daemon state file, file permissions, atomic
startup lock, health validation, stale-state recovery, and version comparison.
It contains no HTTP routing or Context Map parsing.

### `viewer/runtime/daemon-server.mjs`

Owns the loopback listener, authenticated control routes, token-scoped Viewer
routes, security headers, static asset allowlist, and graceful shutdown. It
does not interpret Agent hosts.

### `viewer/runtime/session-manager.mjs`

Owns project-store reuse, immutable session bindings, token generation,
per-session idle deadlines, capacity limits, LRU behavior, and release of
unused stores. The daemon exits as soon as its final live session has expired
and cleanup completes.

### Context Store and Web UI

The existing parser, source validation, watcher/polling fallback, UI model, and
browser behavior move from `plugins/context-map-viewer/` into `viewer/` with no
host-specific dependencies. Browser code consumes the same-origin HTTP
transport only; MCP transport code is removed.

## Daemon Discovery and Startup

### Runtime directory

The daemon uses a per-user runtime directory:

- Linux: `$XDG_RUNTIME_DIR/handoff/` when available and owned by the current
  user; otherwise a user-specific directory below `os.tmpdir()`.
- macOS: a user-specific directory below `os.tmpdir()`.
- Windows: a user-specific directory below the process temporary directory,
  with access restricted using the strongest permissions available to Node.

The directory must not be inside a project or `.handoff/`. State and lock files
must be readable and writable only by the current user where POSIX modes are
available. Unsafe ownership, a symlinked state directory, or unexpectedly broad
POSIX permissions produces `VIEW_STATE_UNSAFE`; the CLI does not weaken them
silently.

### State file

The daemon atomically publishes a state record containing:

```json
{
  "schemaVersion": 1,
  "daemonVersion": "2.4.0",
  "pid": 12345,
  "port": 54321,
  "controlToken": "opaque-random-secret",
  "startedAt": "ISO-8601"
}
```

The control token is never printed, logged, embedded in Viewer URLs, or stored
in project files. A state record is accepted only after an authenticated health
request confirms the expected PID, port, schema, and daemon version. PID
existence alone is never sufficient because PIDs can be reused.

### Concurrent startup

The first caller creates an exclusive startup lock. The winner starts a
detached Node child with ignored stdin and controlled log handling. Other
callers poll for a valid health-checked state until the bounded startup timeout.
If the lock owner dies, its lock becomes recoverable only after both its age and
the absence of a valid daemon are established. A caller never deletes a lock
that may still belong to a starting healthy process.

### Stale and incompatible state

Missing listener, failed authenticated health check, invalid state, or reused
PID makes the record stale. The CLI removes only the validated Handoff daemon
state record and retries startup. When daemon versions differ, the CLI requests
authenticated graceful shutdown of the old daemon, waits for exit, and starts
the installed version. If authenticated shutdown is impossible, it reports
`VIEW_DAEMON_VERSION_CONFLICT` rather than killing an arbitrary PID.

## HTTP Interfaces

The server binds to the literal host `127.0.0.1` and port `0` only.

### Control plane

- `GET /control/health`
- `POST /control/session`
- `POST /control/shutdown`

Every control request carries the control token in an authorization header.
Control routes never accept credentials in query strings. Responses use
`Cache-Control: no-store` and never echo the control token.

`POST /control/session` accepts the canonical project root and validated idle
minutes from the local CLI. It validates that the project is an accessible
directory and that its fixed Context Map source is safe. It returns only a
Viewer URL, safe session ID, source label, and expiry value.

### Viewer plane

The existing fixed routes remain conceptually unchanged:

```text
GET /session/<viewer-token>/
GET /session/<viewer-token>/app.mjs
GET /session/<viewer-token>/model.mjs
GET /session/<viewer-token>/styles.css
GET /session/<viewer-token>/api/context-map
```

Each `/handoff view` call creates a new Viewer token even when the daemon and
project store are reused. Tokens expire independently according to their own
idle deadlines. A Viewer token cannot call control routes, list sessions, or
access another token.

## Security Requirements

- Literal `127.0.0.1` binding; no wildcard, LAN, or public listener.
- Cryptographically random control and Viewer tokens with bounded collision
  retries.
- Canonical project roots and fixed `.handoff/context-map.md` resolution.
- Existing symlink-escape, same-open-file, source-size, and node-count checks.
- Exact route and method allowlists; encoded traversal is rejected before URL
  normalization.
- Existing CSP, `no-store`, referrer policy, MIME allowlist, and content-type
  protections.
- No secrets, source contents, control tokens, or absolute project paths in
  normal logs or human-readable CLI output.
- The Viewer remains strictly read-only and never invokes save, load, diff, or
  shell commands.
- Project stores and watchers are disposed when no live session references
  them. Shutdown closes all listeners, stores, timers, and state files.

## Lifecycle

1. The CLI validates flags and canonicalizes the current project.
2. It reads and authenticates the published daemon state.
3. If necessary, exactly one concurrent caller starts the daemon.
4. The CLI creates a project-bound session with its requested idle deadline.
5. The CLI returns the URL; the Agent chooses how to open it.
6. Browser API activity refreshes only that session's idle deadline.
7. Expired sessions are removed and their unused project stores are closed.
8. When no sessions remain, the daemon gracefully closes and removes only its
   own state and lock files.

The daemon is not a permanent service. There is no login item, launch agent,
systemd unit, Windows service, or manual stop command in v2.4.0. Authenticated
shutdown exists only for safe version replacement and test control.

## Error Model

Human-readable errors include a concise correction. JSON errors emit one stable
object on stdout and diagnostics on stderr without interleaving logs.

Stable error codes include:

- `VIEW_REQUIRES_NODE`
- `VIEW_INVALID_IDLE_MINUTES`
- `VIEW_PROJECT_INACCESSIBLE`
- `VIEW_CONTEXT_MISSING`
- `VIEW_CONTEXT_INVALID`
- `VIEW_CONTEXT_TOO_LARGE`
- `VIEW_STATE_UNSAFE`
- `VIEW_DAEMON_START_TIMEOUT`
- `VIEW_DAEMON_VERSION_CONFLICT`
- `VIEW_SESSION_CREATE_FAILED`

Source errors do not reveal hidden content. A missing map directs the user to
`/handoff save`; invalid or oversized maps direct the user to inspect or reduce
the fixed source file.

## Plugin Removal and Migration

The v2.4.0 change removes:

- `plugins/context-map-viewer/`
- `.agents/plugins/marketplace.json` when it has no remaining plugins
- the Codex MCP manifest, MCP App resource, MCP tools, and Viewer-specific Skill
- independent Viewer package versioning and release tags after v0.2.0

Reusable Viewer code and committed build artifacts move into `viewer/` before
the plugin directory is deleted. Handoff package `files` includes `viewer/` and
excludes obsolete plugin paths. Root README, Handoff Skill, install scripts, and
examples document `/handoff view`.

Release notes instruct existing Codex users to remove
`context-map-viewer@handoff-protocol`. The generic command does not depend on
Codex's plugin cache, MCP, or Marketplace. The Git Marketplace may remain
configured for unrelated future plugins, but it no longer advertises this
Viewer.

## Testing Strategy

### Unit tests

- Argument parsing, stable errors, JSON cleanliness, and idle range 1–1440.
- Runtime directory selection, ownership/mode validation, state parsing,
  version checks, and stale-state classification.
- Exclusive startup locking, bounded waits, safe stale-lock recovery, and
  concurrent caller behavior using injected clocks and filesystem adapters.
- Token generation, collision limits, project-store reference counts, session
  TTL, capacity, LRU ordering, and immutable project bindings.
- Canonical source resolution, parser limits, and watcher fallback.

### Integration tests

- Several concurrent CLI calls create one daemon and distinct Viewer tokens.
- One daemon serves two projects without content or watcher crossover.
- Modify, atomically replace, delete, and recreate each project's map.
- Sessions with different idle values expire independently.
- The final session expiry closes project stores, daemon listener, and state.
- Crash leftovers, malformed state, reused PID simulation, abandoned startup,
  and authenticated version replacement recover safely.
- Unsafe state paths and permission failures make no external changes.

### Web behavior tests

The existing Viewer suite moves with the Web source and continues to cover:

- Tree / Map / Both presentation and responsive layout.
- Shared folding, search highlighting, keyboard navigation, and map centering.
- Long-node details and focus restoration.
- Same-version refresh without DOM reconstruction.
- Terminal session expiry clearing stale details and selection.
- 520 px split-pane drawer bounds and 390 px compact layout.

MCP-only transport and manifest tests are deleted. Equivalent HTTP and generic
CLI behavior tests replace them.

### Release and acceptance gates

- Full root Node suite.
- Full Deno suite for unchanged Handoff commands plus the explicit
  `VIEW_REQUIRES_NODE` behavior.
- Viewer unit, HTTP integration, concurrency, lifecycle, and Web suites.
- `npm pack --dry-run` includes all runtime and built assets.
- No plugin or Marketplace reference remains in shipped documentation or
  package contents except migration notes.
- Manual acceptance in Codex, one non-Codex Agent or terminal environment, and
  a host without browser automation.

## Release Plan

This is a backward-compatible feature release of Handoff Protocol v2.4.0. The
protocol schema remains 2.0.0. Viewer versioning becomes part of the Handoff
product version; v0.2.0 is the final standalone Codex plugin release.

The implementation must land as one reviewed feature branch, remove the plugin
only after the generic runtime and migrated tests are green, and publish v2.4.0
only after the cross-Agent acceptance and package-content gates pass.
