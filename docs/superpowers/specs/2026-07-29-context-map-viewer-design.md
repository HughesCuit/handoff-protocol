# Context Map Viewer Codex Plugin Design

## Summary

`context-map-viewer` is a read-only Codex plugin that visualizes the current
workspace's `.handoff/context-map.md` as a live mind map beside the
conversation.

The plugin belongs to the `handoff-protocol` repository and is released as an
independent Codex plugin. It does not introduce another state store:
`.handoff/context-map.md` remains the only semantic source of truth.

## Goals

- Follow the current Codex workspace automatically.
- Render `.handoff/context-map.md` as an interactive, horizontal mind map.
- Refresh after file creation, modification, atomic replacement, or deletion.
- Support zooming, panning, fit-to-view, folding, and search.
- Preserve view state across successful live refreshes.
- Keep file access read-only and confined to the active workspace.

## Non-goals

The first release will not:

- edit or write Context Map nodes;
- invoke Handoff `save`, `load`, or `diff`;
- select arbitrary files outside the current workspace;
- switch among multiple projects inside one panel;
- export images or other artifacts;
- generate Obsidian Canvas or Dataview content;
- add a database, remote service, user-level index, or persistent search index;
- provide a node details panel.

## Repository and Packaging

The plugin lives at:

```text
plugins/context-map-viewer/
```

It has its own Codex plugin manifest, application UI, MCP server, tests, and
build configuration. It may reuse Handoff parsing behavior, but its release is
independent from the core protocol package.

The normalized plugin name is `context-map-viewer`.

## Architecture

The plugin uses a native Codex App backed by a local, read-only MCP server.

```text
Current Codex workspace
  -> .handoff/context-map.md
  -> secure reader and Handoff semantic parser
  -> structured render tree plus file version
  -> Codex App SVG canvas
```

### Context Map Reader

The reader:

- resolves only `<workspace>/.handoff/context-map.md`;
- rejects path traversal and symlink escape outside the workspace;
- enforces size and node-count limits before rendering;
- parses Handoff sections and nested Markdown nodes;
- produces a stable renderer DTO rather than exposing raw file access to the UI.

### Context Map Watcher

The watcher:

- handles file creation, modification, atomic rename, and deletion;
- debounces bursts caused by atomic writes;
- reparses only when the file version changes;
- publishes a new full render snapshot to the App;
- stops before binding to another workspace.

Native change notifications are preferred. A low-frequency incremental polling
fallback is allowed when the host cannot deliver reliable filesystem events.

### Context Map App

The App:

- receives structured snapshots from the MCP server;
- renders a horizontal SVG tree;
- owns transient UI state such as viewport, search, and folded nodes;
- never reads or writes local files directly.

The user opens the panel explicitly once. It then remains available beside the
current Codex task and follows the active workspace.

## Renderer Data Contract

The MCP response contains:

- workspace-relative source identity;
- a monotonically changing file version or content digest;
- synchronization status;
- an ordered tree of render nodes;
- structured, non-sensitive diagnostics.

Each render node contains:

- a stable ID derived from semantic section, ancestor path, normalized text,
  and same-path occurrence;
- semantic section;
- display text;
- ordered children;
- task state when applicable;
- risk or exclusion state when applicable;
- optional origin metadata for lightweight attribution.

Stable IDs allow fold state to survive a refresh. When an edited node no longer
has the same ID, the App preserves state for all other matching nodes and falls
back to the default expanded state for the changed node.

## User Interface

### Layout

The panel uses a pure-canvas layout:

- a compact toolbar at the top;
- the SVG mind-map canvas below it;
- no permanently visible outline or details pane.

The root is placed on the left and branches grow to the right. Original Context
Map section and node order is preserved.

### Toolbar

The toolbar contains:

- search;
- zoom out;
- current zoom percentage;
- zoom in;
- fit to view;
- expand all;
- collapse all;
- synchronization status.

### Node Presentation

Top-level semantic sections such as Goals, Status, Tasks, Decisions, Questions,
and Risks use consistent semantic colors. State is never communicated by color
alone:

- open and completed tasks use distinct icons;
- excluded nodes use a distinct icon or border;
- high-risk nodes use a distinct icon or border;
- origin metadata is omitted from primary text and may appear as a subtle
  attribution indicator.

### Navigation and Zoom

Users can:

- drag to pan;
- use the mouse wheel or trackpad to zoom;
- use toolbar zoom controls;
- restore an automatic fit-to-view transform.

### Folding

Clicking a node toggles its children. Collapse-all retains the root and
top-level semantic sections so the map remains navigable.

Folded branches do not participate in the visible layout calculation.

### Search

Search matches normalized node text plus ancestor paths. During search:

- matching nodes are highlighted;
- nonmatching branches are visually de-emphasized;
- the first or active match is panned into view;
- folded ancestors of a match are temporarily revealed without permanently
  overwriting the user's fold choices.

### Refresh State Preservation

After a valid update, the App preserves:

- viewport and zoom;
- search query;
- fold state for stable node IDs.

It does not unnecessarily reset or relayout the view when the file version is
unchanged.

## Synchronization and Empty States

The toolbar reports:

- `Synced`;
- `Refreshing`;
- `Parse error`.

If a read or parse attempt fails during an update, the App keeps the last valid
map visible and adds the status indicator.

When the file does not exist, the panel explains that
`.handoff/context-map.md` has not been created and suggests running the Handoff
save flow. An empty file receives a separate empty-state message. Unsupported
content produces a concise parse diagnostic without reproducing source content.

## Security and Privacy

- The MCP server is read-only.
- It resolves a fixed workspace-relative path rather than accepting an
  arbitrary user-supplied filename.
- Resolved real paths must remain inside the active workspace.
- Workspace switches clear old project data before binding the new watcher.
- Errors and logs contain codes, paths relative to the workspace, and safe
  summaries, but never the complete Context Map.
- The App receives only the parsed tree required for rendering.
- No Context Map content is persisted outside the project.

## Limits and Performance

The first release applies soft operational limits:

- maximum source size: 2 MiB;
- maximum parsed node count: 2,000.

Files exceeding either limit are not rendered and receive an actionable error.

Performance rules:

- debounce filesystem event bursts;
- parse and lay out only after the file version changes;
- exclude folded subtrees from visible layout;
- keep search indexing in memory only;
- use SVG rather than Canvas or WebGL for the first release.

Acceptance targets:

- a normal local file update enters refresh processing within 500 ms;
- a representative 500-node map remains responsive for pan, zoom, fold, and
  search.

## Error Handling

- A temporary read failure never clears the last valid snapshot.
- A partially written or atomically replaced file is retried through the
  debounced event path.
- A watcher is disposed before workspace rebinding.
- After MCP/App reconnection, the App requests a complete snapshot before
  resuming live updates.
- Structured error codes distinguish missing, empty, invalid, too large,
  too many nodes, access denied, and watcher unavailable.

## Testing

### Unit Tests

- Markdown-to-tree conversion;
- stable node IDs and duplicate occurrences;
- semantic section and task-state mapping;
- original ordering;
- search matching against text and ancestor paths;
- fold-state reconciliation after refresh.

### Security Tests

- path traversal;
- symlink escape;
- oversized input;
- node-count limit;
- source content absent from errors and logs.

### Watcher Tests

- create;
- modify;
- atomic rename;
- delete;
- rapid successive writes and debounce;
- workspace switch and old-watcher disposal;
- polling fallback where supported.

### App Tests

- pan and zoom;
- fit to view;
- expand and collapse;
- search highlighting and navigation;
- state preservation after refresh;
- missing, empty, loading, and error states;
- retention of the last valid map after a failed update.

### Integration and Release Gates

An integration test modifies a real `.handoff/context-map.md` and verifies that
the App receives and displays the new snapshot within the target refresh
window.

Before release:

- all Node and UI tests pass;
- the Codex plugin validator passes;
- the production build completes without warnings;
- three representative real-world Context Maps receive manual acceptance
  testing.

## Success Criteria

The design is successful when a user can open the Context Map panel once,
continue a Codex conversation, and see Handoff Context Map updates appear
without manual reload while retaining control of the map's viewport, search,
and folded branches.
