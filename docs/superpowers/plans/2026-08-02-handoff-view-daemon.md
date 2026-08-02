# Handoff View Daemon Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Add host-independent `/handoff view` that starts/reuses a user-level Viewer daemon and returns a token-scoped loopback URL, replacing the Codex-only plugin.

**Architecture:** User-level Node daemon (loopback HTTP, authenticated control plane + token-scoped viewer plane). CLI validates args, discovers/starts daemon via state file + startup lock, requests session, prints URL. Reusable code migrates from `plugins/context-map-viewer/` to `viewer/`; MCP transport removed.

**Tech Stack:** Node 18+ ESM, `node:http`/`crypto`/`fs`/`os`, esbuild, Node test runner. No Zod, no MCP SDK.

## Global Constraints

- Literal `127.0.0.1` only; crypto-random tokens (>=128 bits); canonical realpath roots; fixed `.handoff/context-map.md`; existing symlink/size/node checks.
- Exact route+method allowlists; encoded traversal rejected; CSP/no-store/nosniff/MIME allowlist.
- No secrets/paths in logs; read-only; `.handoff/`+v2 schema unchanged; Node-only (Deno -> `VIEW_REQUIRES_NODE`).
- Idle 1-1440 min (default 30); max 8 sessions; per-session idle; project stores refcounted; auto-shutdown when empty.
- Handoff Protocol v2.4.0; schema stays 2.0.0.

## File Structure

```
viewer/web/{app,model,transports,standalone.html,styles}.mjs|css|html
viewer/runtime/{constants,context-map-parser,context-source,context-store,session-manager,daemon-server,daemon-state,daemon-main}.mjs
viewer/scripts/build.mjs
viewer/tests/*.test.mjs
viewer/dist/{index.html,app.mjs,model.mjs,styles.css}
scripts/node/view.mjs
scripts/view.ts
tests/node/view-cli.test.mjs
```

## Tasks

### Task 1: Migrate Runtime Core
Copy `constants.mjs`, `context-map-parser.mjs`, `context-source.mjs`, `context-store.mjs` verbatim from `plugins/context-map-viewer/server/` to `viewer/runtime/`. Copy their 4 test files to `viewer/tests/`, rewrite `../server/` -> `../runtime/`. Run tests, commit.

### Task 2: Migrate Web UI (HTTP-only)
Copy `model.mjs`, `styles.css`, `standalone.html` verbatim. Create `transports.mjs` keeping `createHttpTransport`+`createPageLifecycle`+validators, removing MCP transport. Adapt `app.mjs` to use `createHttpTransport` directly (remove `createPageTransport`, `window.openai`, `postMessage`, PiP). Migrate 5 web tests. Run, commit.

### Task 3: Session Manager
Adapt `browser-session-manager.mjs` -> `session-manager.mjs`. Key changes: per-session `idleDeadlineMs` (not global); `projectStores = Map(root -> {store, refCount})` for store reuse; store closed at refcount zero; `idleMinutes` validated 1-1440; `hasSessions` getter. TDD: write tests for per-session idle, store reuse, refcount close, hasSessions, capacity/LRU. Run, commit.

### Task 4: Daemon State (NEW)
Create `daemon-state.mjs`: `getRuntimeDir` (0o700, ownership check, symlink rejection -> `VIEW_STATE_UNSAFE`), `readState`/`writeState` (atomic temp+rename, 0o600), `removeState`, `acquireStartupLock`/`releaseStartupLock`, `isStaleLock`, `healthCheck` (authenticated `GET /control/health`, validate pid/port/schema/version). State: `{schemaVersion:1, daemonVersion, pid, port, controlToken, startedAt}`. TDD then commit.

### Task 5: Daemon Server
Adapt `loopback-viewer-server.mjs` -> `daemon-server.mjs`. Add control plane routes (`GET /control/health`, `POST /control/session`, `POST /control/shutdown`) requiring `Authorization: Bearer <controlToken>`. Keep viewer plane routes/headers/patterns. `POST /control/session` body `{workspaceRoot, idleMinutes}` -> session -> `{url, sessionId, source, idleMinutes}`. TDD then commit.

### Task 6: Daemon Main (NEW)
Create `daemon-main.mjs`: `startDaemon()` loads assets, creates `SessionManager`+`DaemonServer`, generates controlToken, writes state, registers SIGINT/SIGTERM, starts idle-check timer (10s) -> auto-shutdown when `!hasSessions`. On close: stop server, close sessions, remove state+lock. Idempotent. TDD then commit.

### Task 7: Build Script
Adapt `build.mjs`: esbuild `web/app.mjs` -> `dist/app.mjs` (ESM, external `./model.mjs`), copy `model.mjs`/`styles.css`/`standalone.html`->`dist/index.html`. No server bundle, no widget. TDD (build test asserts http marker, api/context-map, no tools/call). Commit.

### Task 8: CLI view.mjs (NEW)
Create `scripts/node/view.mjs`: parse `--idle-minutes N` (1-1440 int) + `--json`; resolve project root (cwd); validate context-map.md; `getRuntimeDir`->`readState`->`healthCheck` (reuse/stale-recover/version-conflict-shutdown); if no daemon, `acquireStartupLock`+spawn detached `daemon-main.mjs`+poll health; `POST /control/session`; print URL (human or JSON). Error codes: `VIEW_INVALID_IDLE_MINUTES`, `VIEW_PROJECT_INACCESSIBLE`, `VIEW_CONTEXT_MISSING`, `VIEW_CONTEXT_INVALID`, `VIEW_CONTEXT_TOO_LARGE`, `VIEW_STATE_UNSAFE`, `VIEW_DAEMON_START_TIMEOUT`, `VIEW_DAEMON_VERSION_CONFLICT`, `VIEW_SESSION_CREATE_FAILED`. TDD then commit.

### Task 9: Deno view.ts stub
Create `scripts/view.ts`: recognize `view`, return `VIEW_REQUIRES_NODE` with Node command suggestion. TDD then commit.

### Task 10: Skill + Package + Docs + Plugin Removal
Add `/handoff view` to SKILL.md. Update package.json (v2.4.0, files add `viewer`/remove plugin, add `viewer:build`/`pretest` scripts, test includes viewer/tests). Update README. Remove `plugins/context-map-viewer/`. Run full release gate. Commit.

## Final Review Gate
- Every design-spec requirement mapped to a task.
- No absolute path or raw content in HTTP DTO or CLI output.
- Sessions own one store; no cross-project inspection.
- All routes require tokens; control routes require control token.
- Shutdown disposes watchers/timers/sockets/stores/state.
- Request code review via superpowers:requesting-code-review.
