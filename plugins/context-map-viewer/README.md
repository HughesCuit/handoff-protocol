# Context Map Viewer

Context Map Viewer is the official read-only Codex visualization companion for
Handoff Protocol. It renders the active workspace's
`.handoff/context-map.md` as a live horizontal mind map.

## Features

- Live refresh after Context Map writes or atomic replacements
- Search across node text and ancestor paths
- Fold, expand, pan, zoom, and fit-to-view controls
- Task, risk, exclusion, and semantic-section styling
- Side-browser presentation in Codex with inline MCP App fallback
- Last-valid-map retention during transient read or parse failures
- Fixed workspace-relative source with symlink-escape protection

The viewer never writes Handoff files and does not run `save`, `load`, or
`diff`.

In Codex, the bundled skill passes the active task's exact absolute `cwd` to
create a browser session, then opens the returned `viewerUrl` in the Codex
in-app browser. This side browser is the default presentation. If browser
session creation or navigation is unavailable, the skill calls
`open_context_map` with the same workspace root and uses the inline MCP App as
a compatibility fallback. The server appends only the fixed
`.handoff/context-map.md` path. Live widget refreshes use an opaque binding ID,
not the local workspace path. MCP Roots remain a fallback for hosts that
support them.

## Install from this repository

Add the repository marketplace once:

```bash
codex plugin marketplace add /absolute/path/to/handoff-protocol
```

Then install the plugin using the marketplace name from
`.agents/plugins/marketplace.json`:

```bash
codex plugin add context-map-viewer@handoff-protocol
```

Restart the ChatGPT desktop app and begin a new Codex task so the bundled skill
and MCP server are loaded. Ask:

```text
Open the Context Map viewer.
```

Codex opens the map in its side browser by default. If that presentation is not
available, the inline MCP App requests picture-in-picture when the host exposes
that capability and otherwise remains inline.

### Navigate large maps

The Viewer opens in **Both** mode with an equivalent tree navigator beside the
mind map. Use **Tree**, **Map**, or **Both** in the toolbar to change the current
presentation. Folding is shared between the tree and map.

Selecting a tree item expands its ancestors and centers the matching map node
without changing zoom. Long labels stay compact in the map; select a node to
open the read-only full-text details drawer.

Live refreshes from the same workspace preserve the current mode, folds,
selection, details, search, and viewport when the selected node still exists.

## Browser session security and lifecycle

The side-browser `viewerUrl` is a local, temporary URL. It listens only on
`127.0.0.1` at a random port and contains an opaque, token-scoped path. Browser
sessions are in-memory only: do not copy, reconstruct, persist, or reuse a URL
in another Codex task. The page automatically polls every 750 ms and a session
expires after 30 minutes of idle time. After expiry, invoke the Viewer skill
again to create and open a fresh URL.

The browser presentation does not change the Handoff storage format or write
to Handoff files.

## States and limits

- Missing file: run the Handoff save flow to create
  `.handoff/context-map.md`.
- Invalid update: the last valid map remains visible with a parse status.
- Maximum source size: 2 MiB.
- Maximum parsed nodes: 2,000.
- Browser page polling interval: 750 ms.

Context Map content is parsed locally, is not indexed persistently, and is not
sent to a remote service by this plugin.

## Develop

```bash
cd plugins/context-map-viewer
npm install
npm run build
npm test
```

`dist/server.bundle.mjs` and `dist/widget.html` are committed because local
plugin installation does not run package lifecycle scripts.
