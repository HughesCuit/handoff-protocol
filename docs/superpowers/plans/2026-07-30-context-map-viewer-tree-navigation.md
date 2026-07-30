# Context Map Viewer Tree Navigation and Node Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared-state tree navigator, tree/map/split display modes, tree-to-map focus, and a read-only full-text node details drawer to Context Map Viewer.

**Architecture:** Extend the existing pure `web/model.mjs` view-state model so the tree panel and SVG map are projections of the same authoritative tree, query, selection, and folded-ID set. Keep DOM rendering in `web/app.mjs`, add semantic containers and controls to the two HTML templates, and use CSS for split, compact, and drawer layouts. Build the inline widget and standalone browser assets from the same source and preserve the existing transport and loopback security boundaries.

**Tech Stack:** JavaScript ES modules, SVG, semantic HTML/CSS, Node.js built-in test runner, esbuild, MCP Apps inline widget, token-scoped loopback standalone Viewer.

## Global Constraints

- The Viewer remains read-only and never writes `.handoff/context-map.md`.
- Initial display mode is `split`.
- Tree and map share one authoritative `Set<string>` of folded node IDs.
- Same-binding refresh preserves display mode, selection, detail state, folds, query, and transform when referenced nodes still exist.
- Binding changes reset to split mode, clear selection/details/query, and retain the sync-gated initial overview behavior.
- Map labels remain a single bounded line; full node text is shown in the details drawer.
- At widths `>= 560px`, split mode uses a `220px` tree column; at `420px–559px`, it uses a `180px` tree column; below `420px`, it stacks tree and map at `40% / 60%` heights.
- Details use a right-side overlay above `419px` and a full-content-width overlay below `420px`.
- Do not change parser limits, Context Map schema, session URLs, loopback binding, session tokens, workspace isolation, or transport behavior.
- Do not add dependencies, persistence, editing, drag-to-reorder, or Markdown rendering in details.

---

## File Map

- `plugins/context-map-viewer/web/model.mjs` — pure tree indexing, ancestor expansion, label policy, selection reconciliation, and view-state transitions.
- `plugins/context-map-viewer/web/app.mjs` — shared action handlers plus tree, map, mode, selection, and details rendering.
- `plugins/context-map-viewer/web/index.html` — inline MCP widget semantic structure.
- `plugins/context-map-viewer/web/standalone.html` — standalone browser semantic structure kept equivalent to `index.html`.
- `plugins/context-map-viewer/web/styles.css` — display modes, tree hierarchy, selected states, responsive split layout, and drawer.
- `plugins/context-map-viewer/tests/web-model.test.mjs` — pure tree-navigation and truncation tests.
- `plugins/context-map-viewer/tests/web-view-state.test.mjs` — same-binding and binding-change state transition tests.
- `plugins/context-map-viewer/tests/web-interface-contract.test.mjs` — source and generated-asset interaction/accessibility contracts.
- `plugins/context-map-viewer/README.md` — user-visible Viewer controls and behavior.

---

### Task 1: Shared Navigation and Selection Model

**Files:**
- Modify: `plugins/context-map-viewer/web/model.mjs`
- Modify: `plugins/context-map-viewer/tests/web-model.test.mjs`
- Modify: `plugins/context-map-viewer/tests/web-view-state.test.mjs`

**Interfaces:**
- Produces: `indexTree(root) -> Map<string, { node, ancestors }>`
- Produces: `expandAncestors(folded, nodeId, index) -> Set<string>`
- Produces: `reconcileSelectedNode(selectedNodeId, root) -> string | null`
- Produces: `isLabelTruncated(text, limit = 28) -> boolean`
- Produces: `truncateLabel(text, limit = 28) -> string`
- Extends: `createViewState()` with `displayMode`, `selectedNodeId`, and `detailOpen`
- Extends: `transitionSnapshotViewState(previous, next, stage)` with selection and details reconciliation

- [ ] **Step 1: Add failing tree-navigation tests**

Append to `tests/web-model.test.mjs` and import the new functions:

```js
import {
  expandAncestors,
  indexTree,
  isLabelTruncated,
  reconcileSelectedNode,
  truncateLabel,
} from "../web/model.mjs";

test("tree index records complete ordered ancestor paths", () => {
  const index = indexTree(TREE);
  assert.deepEqual(
    index.get("svg").ancestors.map((node) => node.id),
    ["root", "tasks", "build"],
  );
  assert.equal(index.get("svg").node.text, "Use SVG canvas");
});

test("selecting a hidden node expands every ancestor without mutating input", () => {
  const folded = new Set(["tasks", "build", "risks"]);
  const next = expandAncestors(folded, "svg", indexTree(TREE));
  assert.deepEqual([...folded], ["tasks", "build", "risks"]);
  assert.deepEqual([...next], ["risks"]);
});

test("selection reconciliation and the shared 28-character label policy are deterministic", () => {
  assert.equal(reconcileSelectedNode("svg", TREE), "svg");
  assert.equal(reconcileSelectedNode("missing", TREE), null);
  assert.equal(isLabelTruncated("x".repeat(28)), false);
  assert.equal(isLabelTruncated("x".repeat(29)), true);
  assert.equal(truncateLabel("x".repeat(29)), `${"x".repeat(27)}…`);
});
```

- [ ] **Step 2: Run the model tests and verify failure**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs
```

Expected: FAIL because `expandAncestors`, `indexTree`, `isLabelTruncated`, `reconcileSelectedNode`, and `truncateLabel` are not exported.

- [ ] **Step 3: Implement the pure navigation helpers**

Add to `web/model.mjs`:

```js
export const NODE_LABEL_LIMIT = 28;

export function indexTree(root) {
  const index = new Map();
  walk(root, (node, ancestors) => {
    index.set(node.id, { node, ancestors });
  });
  return index;
}

export function expandAncestors(folded, nodeId, index) {
  const next = new Set(folded);
  for (const ancestor of index.get(nodeId)?.ancestors ?? []) {
    next.delete(ancestor.id);
  }
  return next;
}

export function reconcileSelectedNode(selectedNodeId, root) {
  if (!selectedNodeId || !root) return null;
  return collectIds(root).has(selectedNodeId) ? selectedNodeId : null;
}

export function isLabelTruncated(text, limit = NODE_LABEL_LIMIT) {
  return String(text).length > limit;
}

export function truncateLabel(text, limit = NODE_LABEL_LIMIT) {
  const value = String(text);
  return isLabelTruncated(value, limit)
    ? `${value.slice(0, limit - 1)}…`
    : value;
}
```

- [ ] **Step 4: Add failing view-state transition tests**

In `tests/web-view-state.test.mjs`, assert the new initial and transition fields:

```js
test("navigation state defaults to split and survives a same-binding refresh", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  state = {
    ...state,
    displayMode: "tree",
    selectedNodeId: "svg",
    detailOpen: true,
  };

  state = controller.transition(state, {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);

  assert.equal(state.displayMode, "tree");
  assert.equal(state.selectedNodeId, "svg");
  assert.equal(state.detailOpen, true);
});

test("removed selections close details and binding changes reset navigation state", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  state = {
    ...state,
    displayMode: "map",
    selectedNodeId: "svg",
    detailOpen: true,
  };

  const withoutSvg = structuredClone(TREE);
  withoutSvg.root.children[0].children[0].children = [];
  state = controller.transition(state, {
    bindingId: "workspace-a",
    status: "synced",
    tree: withoutSvg,
  }, STAGE);
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.detailOpen, false);

  state = controller.transition({
    ...state,
    selectedNodeId: "tasks",
    detailOpen: true,
    displayMode: "map",
  }, {
    bindingId: "workspace-b",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  assert.equal(state.displayMode, "split");
  assert.equal(state.selectedNodeId, null);
  assert.equal(state.detailOpen, false);
});
```

- [ ] **Step 5: Run the view-state tests and verify failure**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-view-state.test.mjs
```

Expected: FAIL because the new navigation state is absent or not reconciled.

- [ ] **Step 6: Extend view-state creation and transitions**

Update `createViewState()`:

```js
export function createViewState() {
  return {
    bindingId: null,
    tree: null,
    folded: new Set(),
    query: "",
    transform: { x: 36, y: 36, scale: 1 },
    overviewPending: true,
    displayMode: "split",
    selectedNodeId: null,
    detailOpen: false,
  };
}
```

In the binding-change branch of `transitionSnapshotViewState`, explicitly set:

```js
displayMode: "split",
selectedNodeId: null,
detailOpen: false,
```

In the same-binding synced return, derive:

```js
const selectedNodeId = reconcileSelectedNode(scoped.selectedNodeId, root);
return {
  ...scoped,
  tree: next.tree,
  folded: reconcileFoldState(scoped.folded, root),
  selectedNodeId,
  detailOpen: selectedNodeId ? scoped.detailOpen : false,
};
```

Apply the same selection reconciliation to the initial-overview return without changing its fitted transform.

- [ ] **Step 7: Run focused and full plugin tests**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs tests/web-view-state.test.mjs
npm test
```

Expected: focused tests PASS; full plugin tests PASS.

- [ ] **Step 8: Commit the model increment**

```bash
git add plugins/context-map-viewer/web/model.mjs \
  plugins/context-map-viewer/tests/web-model.test.mjs \
  plugins/context-map-viewer/tests/web-view-state.test.mjs
git commit -m "feat(viewer): model shared tree navigation state"
```

---

### Task 2: Display Modes and Equivalent Tree Panel

**Files:**
- Modify: `plugins/context-map-viewer/web/index.html`
- Modify: `plugins/context-map-viewer/web/standalone.html`
- Modify: `plugins/context-map-viewer/web/styles.css`
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Create: `plugins/context-map-viewer/tests/web-interface-contract.test.mjs`

**Interfaces:**
- Consumes: `viewState.displayMode`, `buildVisibleTree`, `indexTree`, and the shared `viewState.folded`
- Produces: DOM elements `#mode-tree`, `#mode-map`, `#mode-split`, `#tree-pane`, `#tree-root`, `#map-pane`
- Produces: `setDisplayMode(mode)`, `renderNavigationTree()`, and the initial `selectNode(nodeId)` selection action

- [ ] **Step 1: Write failing source-template contracts**

Create `tests/web-interface-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(name) {
  return readFile(new URL(name, root), "utf8");
}

test("inline and standalone templates expose equivalent view controls and panes", async () => {
  for (const file of ["web/index.html", "web/standalone.html"]) {
    const html = await source(file);
    for (const id of [
      "view-modes",
      "mode-tree",
      "mode-map",
      "mode-split",
      "tree-pane",
      "tree-root",
      "map-pane",
      "details-drawer",
      "details-close",
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `${file}: ${id}`);
    }
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /role="tree"/);
  }
});

test("app source contains one shared folding action and no tree-only fold cache", async () => {
  const app = await source("web/app.mjs");
  assert.match(app, /function toggleFold\(nodeId\)/);
  assert.match(app, /function renderNavigationTree\(\)/);
  assert.doesNotMatch(app, /treeFolded|menuFolded/);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-interface-contract.test.mjs
```

Expected: FAIL because controls, panes, and render functions do not exist.

- [ ] **Step 3: Add equivalent semantic structure to both templates**

Inside each toolbar, add:

```html
<div id="view-modes" class="view-modes" role="radiogroup" aria-label="View mode">
  <button id="mode-tree" type="button" role="radio" aria-checked="false" data-mode="tree">Tree</button>
  <button id="mode-map" type="button" role="radio" aria-checked="false" data-mode="map">Map</button>
  <button id="mode-split" type="button" role="radio" aria-checked="true" data-mode="split">Both</button>
</div>
```

Replace the stage contents with:

```html
<div id="tree-pane" class="tree-pane">
  <div id="tree-root" class="tree-root" role="tree" aria-label="Context Map tree"></div>
</div>
<section id="map-pane" class="map-pane" aria-label="Context Map canvas">
  <svg id="canvas" role="img" aria-label="Handoff Context Map">
    <g id="viewport">
      <g id="links"></g>
      <g id="nodes"></g>
    </g>
  </svg>
</section>
<aside id="details-drawer" class="details-drawer" aria-labelledby="details-title" hidden>
  <button id="details-close" type="button" aria-label="Close node details">×</button>
  <h2 id="details-title" tabindex="-1">Node details</h2>
  <div id="details-path" class="details-path"></div>
  <p id="details-text" class="details-text"></p>
  <dl id="details-meta" class="details-meta"></dl>
</aside>
<div id="empty-state" class="empty-state" hidden></div>
```

- [ ] **Step 4: Add display-mode and tree CSS**

Add styles with these exact layout contracts:

```css
.stage {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
}

.stage[data-mode="tree"] { grid-template-columns: minmax(0, 1fr); }
.stage[data-mode="map"] { grid-template-columns: minmax(0, 1fr); }
.stage[data-mode="tree"] .map-pane,
.stage[data-mode="map"] .tree-pane { display: none; }

.tree-pane {
  min-width: 0;
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--panel);
}

.tree-item {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  width: 100%;
}

.tree-item[aria-selected="true"],
.map-node.selected rect {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 559px) and (min-width: 420px) {
  .stage[data-mode="split"] { grid-template-columns: 180px minmax(0, 1fr); }
}

@media (max-width: 419px) {
  .stage[data-mode="split"] {
    grid-template-columns: 1fr;
    grid-template-rows: 40% 60%;
  }
  .stage[data-mode="split"] .tree-pane {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
```

- [ ] **Step 5: Implement shared folding and tree rendering**

In `web/app.mjs`, import `indexTree` and add:

```js
const treePane = document.getElementById("tree-pane");
const treeRoot = document.getElementById("tree-root");
const mapPane = document.getElementById("map-pane");

function toggleFold(nodeId) {
  const folded = new Set(viewState.folded);
  if (folded.has(nodeId)) folded.delete(nodeId);
  else folded.add(nodeId);
  viewState = { ...viewState, folded };
  renderAllViews();
}

function selectNode(nodeId) {
  if (!viewState.tree?.root) return;
  if (!indexTree(viewState.tree.root).has(nodeId)) return;
  viewState = { ...viewState, selectedNodeId: nodeId };
  renderAllViews();
}

function renderNavigationTree() {
  treeRoot.replaceChildren();
  if (!viewState.tree?.root) return;
  const visible = buildVisibleTree(
    viewState.tree.root,
    viewState.folded,
    viewState.query,
  );

  const renderNode = (node, level) => {
    const row = document.createElement("div");
    row.className = "tree-item";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(level));
    row.setAttribute("aria-selected", String(viewState.selectedNodeId === node.id));
    row.style.setProperty("--tree-depth", String(level - 1));
    const hasChildren = (indexTree(viewState.tree.root).get(node.id)?.node.children?.length ?? 0) > 0;
    if (hasChildren) {
      row.setAttribute("aria-expanded", String(!viewState.folded.has(node.id)));
    }
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "tree-disclosure";
    disclosure.textContent = hasChildren
      ? (viewState.folded.has(node.id) ? "+" : "−")
      : "";
    disclosure.disabled = !hasChildren;
    disclosure.setAttribute(
      "aria-label",
      `${viewState.folded.has(node.id) ? "Expand" : "Collapse"} ${node.text}`,
    );
    disclosure.addEventListener("click", () => toggleFold(node.id));

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tree-label";
    label.textContent = `${iconFor(node)}${node.text}`;
    label.addEventListener("click", () => selectNode(node.id));
    row.append(disclosure, label);
    treeRoot.append(row);
    for (const child of node.children ?? []) renderNode(child, level + 1);
  };
  renderNode(visible.root, 1);
}

function setDisplayMode(mode) {
  if (!["tree", "map", "split"].includes(mode)) return;
  viewState = { ...viewState, displayMode: mode };
  stage.dataset.mode = mode;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  }
  renderAllViews();
}
```

Replace the map's private fold handler with `toggleFold(node.id)`. Add `renderAllViews()` that calls `renderNavigationTree()`, `renderMap()`, and `renderDisplayMode()`; rename the existing `renderTree()` to `renderMap()` to avoid confusing the two projections. Task 3 extends `renderAllViews()` with details rendering and replaces the initial selection action with focus-aware selection.

- [ ] **Step 6: Wire mode controls and preserve existing commands**

Add:

```js
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setDisplayMode(button.dataset.mode));
}
```

Update search, expand, collapse, snapshot, and resize handlers to call `renderAllViews()` or the narrowest needed renderer. Keep `fitView`, zoom, pan, transport lifecycle, and empty-state behavior unchanged.

- [ ] **Step 7: Run focused tests, build, and full plugin tests**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-interface-contract.test.mjs
npm run build
npm test
```

Expected: all tests PASS and both `dist/widget.html` and `dist/standalone/index.html` contain the three mode controls and tree pane.

- [ ] **Step 8: Commit the display-mode and tree increment**

```bash
git add plugins/context-map-viewer/web/index.html \
  plugins/context-map-viewer/web/standalone.html \
  plugins/context-map-viewer/web/styles.css \
  plugins/context-map-viewer/web/app.mjs \
  plugins/context-map-viewer/tests/web-interface-contract.test.mjs \
  plugins/context-map-viewer/dist
git commit -m "feat(viewer): add shared tree navigation modes"
```

---

### Task 3: Tree-to-Map Focus and Full-Text Details

**Files:**
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Modify: `plugins/context-map-viewer/web/styles.css`
- Modify: `plugins/context-map-viewer/tests/web-interface-contract.test.mjs`
- Modify: `plugins/context-map-viewer/tests/web-model.test.mjs`

**Interfaces:**
- Consumes: `expandAncestors`, `focusNodeTransform`, `indexTree`, `isLabelTruncated`, `truncateLabel`
- Produces: `selectNode(nodeId, source, returnFocus)`, `closeDetails()`, `renderDetails()`
- Produces: distinct `.node-body` and `.node-disclosure` SVG actions

- [ ] **Step 1: Add failing selection and details contracts**

Append to `tests/web-interface-contract.test.mjs`:

```js
test("selection expands ancestors, focuses the map, and details render authoritative text", async () => {
  const app = await source("web/app.mjs");
  assert.match(app, /function selectNode\(nodeId, source\)/);
  assert.match(app, /expandAncestors\(viewState\.folded, nodeId,/);
  assert.match(app, /focusNodeTransform\(/);
  assert.match(app, /function renderDetails\(\)/);
  assert.match(app, /detailsText\.textContent = selected\.node\.text/);
  assert.match(app, /class: "node-disclosure"/);
  assert.match(app, /class: "node-body"/);
});

test("details styling is an overlay and compact mode becomes full width", async () => {
  const css = await source("web/styles.css");
  assert.match(css, /\.details-drawer\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.details-drawer\s*\{[^}]*right:\s*0/s);
  assert.match(css, /@media \(max-width: 419px\)[\s\S]*\.details-drawer[\s\S]*width:\s*100%/);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-interface-contract.test.mjs
```

Expected: FAIL because selection, details, and distinct SVG action classes are missing.

- [ ] **Step 3: Implement authoritative selection and focus**

Add DOM bindings and a focus-return slot:

```js
const detailsDrawer = document.getElementById("details-drawer");
const detailsTitle = document.getElementById("details-title");
const detailsPath = document.getElementById("details-path");
const detailsText = document.getElementById("details-text");
const detailsMeta = document.getElementById("details-meta");
let detailsReturnFocus = null;
```

Implement:

```js
function selectNode(nodeId, source, returnFocus = document.activeElement) {
  if (!viewState.tree?.root) return;
  const index = indexTree(viewState.tree.root);
  const selected = index.get(nodeId);
  if (!selected) return;
  viewState = {
    ...viewState,
    selectedNodeId: nodeId,
    folded: expandAncestors(viewState.folded, nodeId, index),
    detailOpen: source === "map" || isLabelTruncated(selected.node.text),
  };
  detailsReturnFocus = returnFocus;
  renderAllViews();

  if (viewState.displayMode !== "tree") {
    const visible = buildVisibleTree(
      viewState.tree.root,
      viewState.folded,
      viewState.query,
    );
    const layout = layoutTree(visible.root);
    viewState = {
      ...viewState,
      transform: focusNodeTransform(
        layout,
        nodeId,
        { width: mapPane.clientWidth, height: mapPane.clientHeight },
        viewState.transform,
      ),
    };
    setTransform();
  }
}
```

If a node is absent from the current search projection, retain selection and leave transform unchanged as required by the design.

- [ ] **Step 4: Split map disclosure from node-body selection**

For every SVG node group:

```js
if (viewState.selectedNodeId === node.id) classes.push("selected");

const body = svgElement("g", {
  class: "node-body",
  role: "button",
  tabindex: 0,
  "aria-label": `Open details for ${node.text}`,
});
body.append(rect, text);
body.addEventListener("click", (event) => {
  event.stopPropagation();
  selectNode(node.id, "map", body);
});
```

Wrap the badge and badge text in:

```js
const disclosure = svgElement("g", {
  class: "node-disclosure",
  role: "button",
  tabindex: 0,
  "aria-label": `${viewState.folded.has(node.id) ? "Expand" : "Collapse"} ${node.text}`,
});
disclosure.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleFold(node.id);
});
```

Give both actions Enter/Space keyboard handlers. Do not retain the old group-level toggle handler.

- [ ] **Step 5: Implement details rendering and focus restoration**

Implement:

```js
function renderDetails() {
  const selected = viewState.tree?.root && viewState.selectedNodeId
    ? indexTree(viewState.tree.root).get(viewState.selectedNodeId)
    : null;
  const open = Boolean(viewState.detailOpen && selected);
  detailsDrawer.hidden = !open;
  if (!open) return;

  detailsText.textContent = selected.node.text;
  detailsPath.textContent = [...selected.ancestors, selected.node]
    .map((node) => node.text)
    .join(" › ");
  detailsMeta.replaceChildren();
  for (const [label, value] of [
    ["Section", selected.node.section],
    ["Task", selected.node.taskState],
    ["Risk", selected.node.risk],
    ["Excluded", selected.node.excluded ? "Yes" : null],
  ]) {
    if (!value) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    detailsMeta.append(term, description);
  }
}

function closeDetails() {
  viewState = { ...viewState, detailOpen: false };
  renderDetails();
  if (detailsReturnFocus?.isConnected) detailsReturnFocus.focus();
  detailsReturnFocus = null;
}
```

Wire `#details-close` to `closeDetails()`. When a selection opens details from closed state, call `detailsTitle.focus()` after rendering.

- [ ] **Step 6: Add overlay and long-label affordance styles**

Add:

```css
.details-drawer {
  position: absolute;
  z-index: 4;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(360px, 72%);
  overflow: auto;
  padding: 18px;
  border-left: 1px solid var(--border);
  background: var(--panel);
  box-shadow: -12px 0 28px rgb(0 0 0 / 14%);
}

.details-drawer[hidden] { display: none; }
.node-body, .node-disclosure { cursor: pointer; }
.map-node.selected rect { stroke: var(--accent); stroke-width: 3; }
.truncated-affordance { fill: var(--accent); }

@media (max-width: 419px) {
  .details-drawer { width: 100%; box-sizing: border-box; }
}
```

Use the shared label policy when rendering each SVG node:

```js
text.textContent = `${iconFor(node)}${truncateLabel(node.text)}`;
if (isLabelTruncated(node.text)) {
  const affordance = svgElement("text", {
    class: "truncated-affordance",
    x: node.width - 14,
    y: 26,
    "aria-hidden": "true",
  });
  affordance.textContent = "…";
  body.append(affordance);
}
```

- [ ] **Step 7: Verify details, focus, and regressions**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs tests/web-interface-contract.test.mjs
npm test
```

Expected: all tests PASS; existing pan, zoom, fold, search, and lifecycle tests remain green.

- [ ] **Step 8: Commit the focus and details increment**

```bash
git add plugins/context-map-viewer/web/app.mjs \
  plugins/context-map-viewer/web/styles.css \
  plugins/context-map-viewer/tests/web-model.test.mjs \
  plugins/context-map-viewer/tests/web-interface-contract.test.mjs \
  plugins/context-map-viewer/dist
git commit -m "feat(viewer): navigate and inspect full node details"
```

---

### Task 4: Accessibility, Keyboard Tree Navigation, and Refresh Edge Cases

**Files:**
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Modify: `plugins/context-map-viewer/web/styles.css`
- Modify: `plugins/context-map-viewer/tests/web-interface-contract.test.mjs`
- Modify: `plugins/context-map-viewer/tests/web-view-state.test.mjs`

**Interfaces:**
- Consumes: shared selection/folding actions and `transitionSnapshotViewState`
- Produces: roving tree focus via `moveTreeFocus(currentId, direction)`
- Produces: safe drawer cleanup when selection disappears or binding changes

- [ ] **Step 1: Add failing accessibility and stale-selection tests**

Append to `tests/web-interface-contract.test.mjs`:

```js
test("tree supports roving keyboard focus and details restore focus", async () => {
  const app = await source("web/app.mjs");
  assert.match(app, /function moveTreeFocus\(currentId, direction\)/);
  assert.match(app, /case "ArrowDown"/);
  assert.match(app, /case "ArrowUp"/);
  assert.match(app, /case "ArrowRight"/);
  assert.match(app, /case "ArrowLeft"/);
  assert.match(app, /detailsReturnFocus\?\.isConnected/);
});
```

Append to `tests/web-view-state.test.mjs`:

```js
test("same-binding invalid snapshots retain details but a later deletion closes them", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  state = { ...state, selectedNodeId: "svg", detailOpen: true };

  const retained = controller.transition(state, {
    bindingId: "workspace-a",
    status: "invalid",
    tree: structuredClone(TREE),
  }, STAGE);
  assert.equal(retained.selectedNodeId, "svg");
  assert.equal(retained.detailOpen, true);

  const withoutSvg = structuredClone(TREE);
  withoutSvg.root.children[0].children[0].children = [];
  const deleted = controller.transition(retained, {
    bindingId: "workspace-a",
    status: "synced",
    tree: withoutSvg,
  }, STAGE);
  assert.equal(deleted.selectedNodeId, null);
  assert.equal(deleted.detailOpen, false);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-interface-contract.test.mjs tests/web-view-state.test.mjs
```

Expected: FAIL because keyboard traversal is missing or transient snapshot behavior is incorrect.

- [ ] **Step 3: Implement roving tree keyboard navigation**

Build an ordered list from the current visible tree and implement:

```js
function moveTreeFocus(currentId, direction) {
  const items = [...treeRoot.querySelectorAll('[role="treeitem"]')];
  const index = items.findIndex((item) => item.dataset.nodeId === currentId);
  const target = direction === "next" ? items[index + 1] : items[index - 1];
  target?.querySelector(".tree-label")?.focus();
}
```

On each tree label:

```js
label.addEventListener("keydown", (event) => {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveTreeFocus(node.id, "next");
      break;
    case "ArrowUp":
      event.preventDefault();
      moveTreeFocus(node.id, "previous");
      break;
    case "ArrowRight":
      event.preventDefault();
      if (hasChildren && viewState.folded.has(node.id)) toggleFold(node.id);
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (hasChildren && !viewState.folded.has(node.id)) toggleFold(node.id);
      else focusTreeItem(parentId);
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      selectNode(node.id, "tree", label);
      break;
  }
});
```

Set `data-node-id`, `aria-level`, `aria-expanded`, `aria-selected`, and one roving `tabindex="0"`; other labels use `tabindex="-1"`.

- [ ] **Step 4: Reconcile details after every snapshot transition**

After `transitionSnapshotViewState`, compare the previous and next selected IDs. If selection was removed or binding changed:

```js
detailsReturnFocus = null;
```

Call `renderAllViews()` once. For retained invalid snapshots, keep the previous authoritative tree and details content exactly as the model transition specifies.

- [ ] **Step 5: Run plugin tests and inspect generated accessibility contracts**

Run:

```bash
cd plugins/context-map-viewer
npm test
rg -n 'role="radiogroup"|role="tree"|details-drawer|node-disclosure' \
  dist/widget.html dist/standalone/index.html dist/standalone/app.mjs
```

Expected: all tests PASS and each required marker appears in the applicable generated assets.

- [ ] **Step 6: Commit the accessibility increment**

```bash
git add plugins/context-map-viewer/web/app.mjs \
  plugins/context-map-viewer/web/styles.css \
  plugins/context-map-viewer/tests/web-interface-contract.test.mjs \
  plugins/context-map-viewer/tests/web-view-state.test.mjs \
  plugins/context-map-viewer/dist
git commit -m "fix(viewer): harden tree navigation accessibility"
```

---

### Task 5: Documentation, Full Validation, and Side-Browser Acceptance

**Files:**
- Modify: `plugins/context-map-viewer/README.md`
- Modify: `plugins/context-map-viewer/dist/widget.html`
- Modify: `plugins/context-map-viewer/dist/standalone/app.mjs`
- Modify: `plugins/context-map-viewer/dist/standalone/index.html`
- Modify: `plugins/context-map-viewer/dist/standalone/model.mjs`
- Modify: `plugins/context-map-viewer/dist/standalone/styles.css`

**Interfaces:**
- Consumes: all completed Viewer behavior
- Produces: documented controls and reproducible build outputs

- [ ] **Step 1: Update Viewer documentation**

Add to `plugins/context-map-viewer/README.md`:

```markdown
### Navigate large maps

The Viewer opens in **Both** mode with an equivalent tree navigator beside the
mind map. Use **Tree**, **Map**, or **Both** in the toolbar to change the current
presentation. Folding is shared between the tree and map.

Selecting a tree item expands its ancestors and centers the matching map node
without changing zoom. Long labels stay compact in the map; select a node to
open the read-only full-text details drawer.
```

Document that live same-workspace refresh preserves the current mode, folds, selection, details, search, and viewport when the selected node still exists.

- [ ] **Step 2: Rebuild all generated assets**

Run:

```bash
cd plugins/context-map-viewer
npm run build
```

Expected: `dist/widget.html`, `dist/standalone/app.mjs`, `dist/standalone/index.html`, `dist/standalone/model.mjs`, and `dist/standalone/styles.css` are regenerated from source.

- [ ] **Step 3: Run complete automated validation**

Run from the repository root:

```bash
cd plugins/context-map-viewer
npm test
npm pack --dry-run
cd ../..
node --test "tests/**/*.test.mjs"
git diff --check
```

If Deno is installed, also run:

```bash
deno test --allow-read --allow-write --allow-env --allow-run tests/
```

Expected: plugin tests PASS; package dry-run includes the expected plugin assets; root Node tests PASS; Deno tests PASS when available; `git diff --check` emits no output.

- [ ] **Step 4: Perform manual Codex side-browser acceptance**

Start the current branch's Viewer and verify:

1. initial mode is Both;
2. root and top-level sections are initially visible with semantic sections folded;
3. Tree, Map, and Both show the expected panes;
4. folding a node in the tree immediately changes the map;
5. folding a node in the map immediately changes the tree;
6. selecting a hidden descendant in the tree expands all ancestors and centers the map node without changing zoom;
7. a label longer than 28 characters remains bounded and its full text appears in the drawer;
8. closing details preserves map transform and returns focus;
9. same-binding refresh preserves mode, folds, selection, details, search, and viewport;
10. deletion of the selected node closes details;
11. layouts match the `220px`, `180px`, and stacked responsive contracts; and
12. existing search, pan, zoom, fit, expand, collapse, and session-expiry behavior remains usable.

Record the observed viewport widths, selected node, zoom before/after navigation, and visible pane states in the PR description or a PR comment.

- [ ] **Step 5: Commit documentation and generated assets**

```bash
git add plugins/context-map-viewer/README.md plugins/context-map-viewer/dist
git commit -m "docs(viewer): document tree navigation and details"
```

- [ ] **Step 6: Push and update the existing pull request**

```bash
git push origin codex/context-map-side-browser
```

Update PR `#13` with:

- the new tree/map/split interaction summary;
- the shared-state synchronization design;
- node-details and accessibility behavior;
- automated test totals; and
- manual side-browser acceptance observations.
