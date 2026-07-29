# Context Map Viewer

Context Map Viewer is the official read-only Codex visualization companion for
Handoff Protocol. It renders the active workspace's
`.handoff/context-map.md` as a live horizontal mind map.

## Features

- Live refresh after Context Map writes or atomic replacements
- Search across node text and ancestor paths
- Fold, expand, pan, zoom, and fit-to-view controls
- Task, risk, exclusion, and semantic-section styling
- Picture-in-picture request with inline fallback
- Last-valid-map retention during transient read or parse failures
- Fixed workspace-relative source with symlink-escape protection

The viewer never writes Handoff files and does not run `save`, `load`, or
`diff`.

In Codex, the bundled skill passes the active task's absolute `cwd` when it
opens the viewer. The server appends only the fixed
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

The UI requests picture-in-picture when the host exposes that capability. It
otherwise remains as an inline MCP App.

## States and limits

- Missing file: run the Handoff save flow to create
  `.handoff/context-map.md`.
- Invalid update: the last valid map remains visible with a parse status.
- Maximum source size: 2 MiB.
- Maximum parsed nodes: 2,000.
- Normal polling fallback interval: 250 ms when native file watching is
  unavailable.

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
