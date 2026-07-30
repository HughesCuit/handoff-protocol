# Context Map Viewer Tree Navigation and Node Details Design

**Date:** 2026-07-30  
**Status:** Approved in conversation

## Goal

Make large Context Maps easier to browse in Codex's narrow side-browser surface by adding:

1. an equivalent collapsible tree navigation panel beside the mind map;
2. top-level controls for tree-only, map-only, and split views;
3. reliable navigation from a tree item to its map node; and
4. a full-text detail surface for nodes whose labels are truncated in the map.

The Viewer remains read-only. This change does not modify the Handoff protocol, Context Map storage, parsing limits, or loopback-session security model.

## User Experience

### Display modes

The toolbar gains a three-option segmented control:

- **Tree** — show only the hierarchical navigation panel.
- **Map** — show only the existing SVG mind map.
- **Both** — show a fixed-width tree panel on the left and the mind map on the right.

The initial display mode is **Both**. Display mode is session-local and is preserved across same-binding live refreshes. It is not written to project files or browser persistence.

In Both mode, the tree is 220 pixels wide when the content area is at least 560 pixels wide. From 420 through 559 pixels, the tree narrows to 180 pixels. Below 420 pixels, Both mode stacks the tree above the map at a 40/60 height split. Responsive presentation never rewrites the selected mode.

### Shared folding

The tree and map share one authoritative set of folded node IDs.

- Expanding or folding a node in either surface updates the shared set.
- Both surfaces rerender from that shared set.
- Search may temporarily reveal matching paths without mutating the shared folded set.
- Clearing search restores the user's previous folding choices.

There is no tree-to-map or map-to-tree synchronization protocol. Both are projections of the same state.

### Tree navigation

The tree reproduces the Context Map hierarchy and semantic status indicators.

Selecting a tree item:

1. sets it as the selected node;
2. removes all of its ancestor IDs from the shared folded set;
3. rerenders both surfaces;
4. centers the corresponding visible map node without changing the current zoom; and
5. opens the details drawer when the node label is truncated.

The tree item disclosure control is separate from item selection. Activating disclosure only changes folding. Tree items support keyboard traversal and expose their level, expanded state, and selected state through accessible attributes.

### Map interaction

The existing map node click target is split conceptually:

- activating the node body selects the node and opens its details;
- activating the `+` or `−` disclosure control changes folding.

The implementation may keep both targets inside the same SVG group, but their event handling and accessible labels must be distinct. Map panning, wheel zooming, fit, expand-all, collapse-all, and search continue to work.

### Node details

Map labels remain a bounded single line so that long text cannot expand node geometry or destabilize the layout. Truncated nodes show a clear affordance that full content is available.

Selecting a node opens a drawer over the right side of the current content area. The drawer:

- shows the complete, untruncated node text;
- shows the ancestor path;
- shows existing semantic metadata such as task state, risk, exclusion, and section when present;
- provides an explicit close button;
- does not alter the map transform when opened or closed; and
- never writes to Context Map files.

The drawer overlays rather than permanently consuming a third column. In Tree-only mode it overlays the tree; in Map-only and Both modes it overlays the right side of the map area.

## State Model

Extend the existing view state with:

```js
{
  displayMode: "tree" | "map" | "split",
  selectedNodeId: string | null,
  detailOpen: boolean
}
```

The existing `folded`, `query`, `transform`, binding state, and initial-overview state remain authoritative.

### Snapshot transitions

For a same-binding snapshot refresh:

- retain display mode;
- intersect folded IDs with the new tree;
- retain the selected node only if its ID still exists;
- close details if the selected node was removed;
- retain map transform;
- retain the current query.

For a binding change:

- reset to split mode;
- clear selection and details;
- reset the query and folded state;
- preserve the existing sync-gated initial-overview behavior.

Invalid or transient snapshots that retain the last valid tree must also retain navigation and detail state.

## Components and Boundaries

### Pure model functions

Add or extend independently testable functions for:

- indexing the authoritative tree by node ID;
- finding a node and its complete ancestor path;
- expanding a target's ancestors in a folded-ID set;
- reconciling selected and folded IDs with a new snapshot;
- deciding whether a label is truncated under the shared label policy; and
- deriving tree and map projections from the same query and folded state.

DOM event handlers must call these functions rather than duplicating traversal logic.

### Tree view

The tree view owns only DOM creation and interaction wiring. It receives the authoritative tree and view state, emits selection or disclosure actions, and does not keep a private hierarchy or folding cache.

### Map view

The map view continues to own SVG layout, transforms, and pointer interactions. Selection styling and node-body/detail behavior are added without changing the parser or transport.

### Details drawer

The drawer receives the selected authoritative node and its path. It renders plain text and existing metadata only. It owns no persistence and no independent selected-node state.

## Search Behavior

Search remains global:

- node text and ancestor paths participate in matching;
- matching nodes and ancestors are revealed in both tree and map projections;
- matching nodes are highlighted in both surfaces;
- the first map match is centered using the current zoom;
- search does not open details automatically; and
- clearing search restores the shared folded state.

## Responsive Behavior

The primary target is the Codex side browser.

- At widths of 560 pixels or more, Both mode uses a 220-pixel tree column and flexible map column.
- At widths from 420 through 559 pixels, Both mode uses a 180-pixel tree column and flexible map column.
- Below 420 pixels, Both mode stacks the tree above the map at a 40/60 height split.
- Opening details uses a right-side overlay drawer above 419 pixels and a full-content-width overlay below 420 pixels.
- The toolbar may wrap, but controls must remain reachable without horizontal page scrolling.

## Accessibility

- The display-mode control exposes a single selected option.
- Tree items expose hierarchy level, selected state, and expanded state.
- Disclosure and selection are separately operable by keyboard.
- The details drawer has a labelled heading and close control.
- Opening the drawer moves focus to its heading or close control.
- Closing the drawer returns focus to the node or tree item that opened it when that element still exists.
- Selected nodes are not communicated by color alone.

## Error and Edge Cases

- If a selected node disappears during refresh, clear selection and close details.
- If a tree selection targets a node unavailable in the current search projection, expand its ancestors and recompute the projection before map positioning.
- If a target cannot be laid out, keep it selected in the tree and leave the current map transform unchanged.
- Missing, empty, invalid, oversized, access-denied, and expired states continue to use the existing status and terminal surfaces.
- A detail drawer never displays stale text after a binding change.

## Testing

### Model tests

- split mode is the default;
- shared folding changes both projections;
- ancestor lookup and automatic ancestor expansion;
- selection reconciliation across same-binding refreshes;
- selection reset on node deletion and binding change;
- truncation detection at and around the label limit;
- search reveals paths without mutating folds; and
- focus transform centers an automatically revealed node without changing zoom.

### DOM and build-contract tests

- mode controls show and hide the correct panes;
- tree and map actions mutate the same view state;
- node body and disclosure actions are distinct;
- long labels remain bounded and open full details;
- drawer content, close behavior, and focus restoration;
- accessibility roles and state attributes;
- standalone assets and inline widget include the same behavior markers; and
- generated standalone model code matches the tested source model.

### Regression and manual acceptance

- existing search, zoom, pan, fit, expand, collapse, refresh, expiry, and workspace isolation tests remain green;
- the root Node suite remains green;
- the Deno suite is run when Deno is available;
- build, `git diff --check`, and `npm pack --dry-run` pass;
- manual side-browser acceptance covers all three modes, narrow layout, tree-to-map navigation, long-node details, and state preservation through live refresh.

## Non-goals

- editing Context Map nodes;
- persisting personal Viewer preferences;
- adding a database or client-side index;
- changing Markdown parsing or Context Map schema;
- adding drag-to-reorder behavior;
- rendering Markdown inside node details; or
- changing the session URL, loopback binding, token, or workspace security model.
