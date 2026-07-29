# Context Map Viewer Side-Browser Design

## Summary

Extend `context-map-viewer` with a standalone, read-only localhost mode so
Codex can display the live Context Map in its side browser instead of inserting
the viewer into the conversation.

In Codex Desktop, opening the Viewer should prefer the side-browser experience.
Hosts without a controllable side browser retain the existing inline MCP App as
the fallback. Both modes render the same parsed snapshot and preserve
`.handoff/context-map.md` as the only semantic source of truth.

## Goals

- Open the Viewer in Codex's side browser by default.
- Continue following the current task's explicitly supplied workspace root.
- Preserve live refresh, zoom, pan, folding, search, and fit-to-view behavior.
- Reuse the current parser, workspace isolation, render data contract, and UI.
- Keep the localhost surface read-only, loopback-only, and scoped to one
  workspace per browser session.
- Keep inline rendering available as a compatibility fallback.

## Non-goals

This increment will not:

- edit Context Map content;
- expose arbitrary local files or directory browsing;
- create a long-running user daemon or background login service;
- add a separate `handoff-viewer` CLI;
- bind to LAN interfaces or provide remote access;
- add authentication intended for untrusted remote clients;
- replace the existing MCP App transport in hosts that use inline rendering.

## User Experience

The skill's normal “open Context Map Viewer” workflow becomes:

1. Determine the current Codex task's absolute workspace root.
2. Ask the Viewer MCP server for a standalone browser session bound to that
   root.
3. Open the returned loopback URL in the Codex in-app side browser.
4. Leave the browser tab open while the user continues the conversation.
5. Refresh the rendered map automatically when
   `.handoff/context-map.md` changes.

If the browser-opening capability is unavailable or the standalone session
cannot be created, the skill calls the existing `open_context_map` tool and
renders the inline MCP App. The fallback is explicit in the tool result so the
agent can describe what happened accurately.

Repeated opens for the same workspace may reuse a live browser session. They
must not rebind an existing session to another workspace.

## Architecture

The MCP server owns a lazy loopback HTTP server:

```text
Codex skill
  -> create_context_map_browser_session(workspaceRoot)
  -> session URL on 127.0.0.1 with opaque token
  -> Codex side browser
       -> viewer HTML/CSS/JS
       -> read-only snapshot endpoint
       -> existing SVG renderer

workspace/.handoff/context-map.md
  -> existing ContextSource and ContextMapStore
  -> session-scoped snapshot
```

The HTTP listener starts only when the first standalone session is requested.
It binds to `127.0.0.1` on an operating-system-assigned port and closes when the
MCP process exits.

### Browser Session Manager

A small session manager has three responsibilities:

- create an opaque, cryptographically random session token;
- bind that token permanently to one canonical workspace root and one
  `ContextMapStore`;
- expire inactive sessions and dispose their stores.

The manager caps live sessions at eight. Sessions expire after 30 minutes
without an HTTP request. Creating a session beyond the cap first removes expired
sessions, then evicts the least recently accessed session. Session state remains
in memory and is never written to the project or user configuration.

### Loopback HTTP Surface

The server exposes only token-scoped `GET` routes:

```text
/session/<token>/
/session/<token>/app.mjs
/session/<token>/model.mjs
/session/<token>/styles.css
/session/<token>/api/context-map
```

The page and asset routes serve the packaged Viewer frontend. The API returns
the same safe render snapshot used by the MCP App. Unknown, expired, or malformed
tokens return `404` without revealing whether a workspace exists.

There are no mutation routes, file path parameters, directory listings,
WebSockets, or cross-origin APIs.

### Shared Frontend

The current Viewer frontend gains a narrow transport abstraction:

- `McpSnapshotTransport` continues to read tool output and request refreshes
  through the MCP Apps bridge.
- `HttpSnapshotTransport` polls the session's
  `api/context-map` endpoint.

Rendering, layout, search, folding, viewport preservation, empty states, and
diagnostics remain shared. The standalone page selects the HTTP transport from
a server-injected same-origin configuration value; the inline resource selects
the MCP transport.

The HTTP transport polls every 750 ms. The underlying `ContextMapStore` still
avoids parsing when the source version is unchanged, so polling does not cause
unnecessary layout work.

## MCP Interface and Skill Behavior

Add a read-only MCP tool:

```text
create_context_map_browser_session({
  workspaceRoot: absolute-path
})
```

Its structured result includes:

- `status`;
- `viewerUrl`;
- opaque `sessionId` suitable for diagnostics but not a filesystem identity;
- workspace-relative source identity;
- a safe error code and fallback recommendation on failure.

The existing `open_context_map` and `refresh_context_map` interfaces remain
compatible.

The plugin skill instructs the agent to:

1. pass the task's exact absolute working directory;
2. prefer `create_context_map_browser_session`;
3. use the Codex in-app browser capability to open `viewerUrl`;
4. fall back to `open_context_map` when either step is unavailable;
5. never invent, transform, or reuse a URL from another task.

Starting the HTTP session and navigating the side browser are separate actions.
This preserves host boundaries: the MCP server creates a safe URL, while Codex
controls its own UI.

## Workspace Binding and Data Flow

Session creation applies the same workspace validation used by the inline
Viewer:

1. require an absolute `workspaceRoot`;
2. resolve and canonicalize it;
3. resolve only `<workspaceRoot>/.handoff/context-map.md`;
4. reject symlink escape and non-file sources;
5. create a store dedicated to that immutable root.

Each API poll asks the store for its current snapshot. A changed source produces
a new version and tree. An unchanged source returns the same version. Temporary
read or parse failures retain the last valid map and update its safe diagnostic,
matching inline behavior.

The browser never sends a workspace path and never receives an absolute one.

## Security and Privacy

- Listen only on IPv4 loopback `127.0.0.1`; do not bind to `0.0.0.0`, IPv6
  wildcard, or a LAN address.
- Use at least 128 bits of cryptographically random token entropy.
- Require the token in every page, asset, and API route.
- Set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a restrictive
  Content Security Policy, and `Referrer-Policy: no-referrer`.
- Allow frontend requests only to the same origin.
- Return no absolute workspace paths, raw Markdown, environment values, or
  directory contents.
- Treat `Host` as untrusted; generated URLs always use literal `127.0.0.1` and
  the actual bound port.
- Reject unsupported methods with `405`.
- Dispose file watchers and in-memory snapshots when a session expires.

The token protects against accidental access by unrelated local pages; this
feature does not claim to isolate data from other processes running as the same
operating-system user.

## Error Handling

- Listener startup failure returns a structured error and recommends inline
  fallback.
- Invalid workspace roots fail before a session or store is retained.
- Browser navigation failure does not destroy the session; the skill falls back
  inline and reports the failure.
- Expired browser tabs show a concise “session expired; reopen Viewer” state
  after receiving `404`.
- A malformed API response keeps the last valid rendered map and shows a
  synchronization error.
- MCP shutdown closes the listener and disposes every session store.

## Testing

### Unit Tests

- Session tokens are random, opaque, and bound immutably to one workspace.
- Session expiry, cap enforcement, least-recently-used eviction, and disposal
  are deterministic under a fake clock.
- The transport abstraction produces identical frontend model updates for MCP
  and HTTP snapshots.
- Standalone configuration cannot inject script or arbitrary endpoints.

### HTTP Integration Tests

- The listener binds to `127.0.0.1` on an assigned port.
- Valid token routes serve the page, assets, and current snapshot.
- Invalid and expired tokens return `404`.
- Non-GET methods return `405`.
- Security and no-cache headers are present.
- Requests cannot select files, traverse paths, or switch workspaces.
- File creation, modification, atomic replacement, deletion, and recovery are
  visible through polling.
- Parse failure preserves the last valid snapshot.
- Shutdown closes the port and disposes stores.

### MCP and Skill Tests

- The new tool validates `workspaceRoot` exactly like the inline tool.
- Its URL contains the bound loopback port and an opaque session token.
- Existing inline tool tests remain unchanged and green.
- Skill instructions prefer side-browser opening and contain a clear inline
  fallback.
- The packaged plugin contains every standalone asset and no development-only
  server dependency.

### Manual Acceptance

In a fresh Codex task:

1. invoke the Viewer skill from a project containing a Context Map;
2. verify a side-browser tab opens rather than an inline map;
3. edit and atomically replace `context-map.md`;
4. verify refresh, zoom, folding, search, and viewport preservation;
5. open another project and confirm the original tab never switches roots;
6. simulate browser-tool unavailability and verify inline fallback.

## Compatibility and Release

This is a backward-compatible feature increment for the independent
`context-map-viewer` plugin. Existing MCP App tools and resources remain
available. No Handoff Protocol file format changes are required.

The release gate is:

- all existing plugin tests pass;
- all new unit and HTTP integration tests pass;
- plugin build and package-content checks pass;
- root Node and Deno suites remain green;
- manual Codex side-browser and inline-fallback checks pass.

