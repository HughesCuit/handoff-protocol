# Context Map Viewer Initial Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open each newly bound Context Map as a fitted semantic-section overview instead of an unreadable fully expanded tree.

**Architecture:** Add pure model helpers that calculate the initial top-level fold set, determine whether a valid tree needs one-time initialization, and calculate a fitted viewport transform. The shared app applies those helpers only for the first valid tree of each `bindingId`, so standalone and inline modes behave identically while same-binding refreshes preserve user state.

**Tech Stack:** Node.js 18+ ESM, SVG, browser DOM APIs, esbuild, Node test runner.

## Global Constraints

- Keep the root and every top-level semantic section visible initially.
- Fold only top-level semantic sections that have children.
- Fit the folded overview to the current viewport.
- Initialize once per valid `bindingId`; missing, invalid, or empty snapshots do not consume initialization.
- Preserve fold choices, search, zoom, pan, and viewport on same-binding refreshes.
- A new binding receives a fresh folded overview.
- Search temporarily reveals folded ancestors without changing stored folds.
- Apply identical behavior to standalone side-browser and inline MCP App modes.
- Do not change server APIs, protocol files, persistence, or Context Map content.

---

### Task 1: One-Time Fitted Section Overview

**Files:**
- Modify: `plugins/context-map-viewer/web/model.mjs`
- Modify: `plugins/context-map-viewer/web/app.mjs`
- Modify: `plugins/context-map-viewer/tests/web-model.test.mjs`
- Modify: `plugins/context-map-viewer/scripts/build.mjs` only through its existing build outputs
- Regenerate: `plugins/context-map-viewer/dist/widget.html`
- Regenerate: `plugins/context-map-viewer/dist/standalone/app.mjs`
- Regenerate: `plugins/context-map-viewer/dist/standalone/model.mjs`

**Interfaces:**
- Consumes: render tree root `{ id, children }`, current and next opaque binding IDs, and viewport `{ width, height }`.
- Produces:
  - `initialOverviewFolds(root): Set<string>`
  - `needsOverviewInitialization(initializedBindingId, nextBindingId, root): boolean`
  - `fitTreeTransform(root, folded, query, stage): { x: number, y: number, scale: number }`

- [ ] **Step 1: Write failing pure-model tests for the fold set and initialization gate**

Add to `tests/web-model.test.mjs`:

```js
test("initial overview folds only top-level sections with children", () => {
  const root = structuredClone(TREE);
  root.children.push({
    id: "empty-section",
    text: "Empty",
    children: [],
  });

  assert.deepEqual(
    [...initialOverviewFolds(root)],
    ["tasks", "risks"],
  );
  const visible = buildVisibleTree(root, initialOverviewFolds(root), "");
  assert.deepEqual(
    visible.root.children.map((node) => node.id),
    ["tasks", "risks", "empty-section"],
  );
  assert.deepEqual(visible.root.children[0].children, []);
});

test("overview initialization waits for a valid tree and runs once per binding", () => {
  assert.equal(needsOverviewInitialization(null, "a", null), false);
  assert.equal(needsOverviewInitialization(null, "a", TREE), true);
  assert.equal(needsOverviewInitialization("a", "a", TREE), false);
  assert.equal(needsOverviewInitialization("a", "b", TREE), true);
});
```

Import the three new model functions explicitly at the top of the test file.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs --test-name-pattern="initial overview|overview initialization"
```

Expected: FAIL because `initialOverviewFolds` and
`needsOverviewInitialization` are not exported.

- [ ] **Step 3: Implement the fold set and initialization gate**

Add to `web/model.mjs`:

```js
export function initialOverviewFolds(root) {
  return new Set(
    (root?.children ?? [])
      .filter((node) => (node.children?.length ?? 0) > 0)
      .map((node) => node.id),
  );
}

export function needsOverviewInitialization(
  initializedBindingId,
  nextBindingId,
  root,
) {
  return Boolean(
    root &&
    nextBindingId &&
    initializedBindingId !== nextBindingId
  );
}
```

Do not change `collapseAll`; the toolbar command retains its existing behavior.

- [ ] **Step 4: Write a failing fitted-transform test**

```js
test("fitted overview transform contains the folded tree in the viewport", () => {
  const folded = initialOverviewFolds(TREE);
  const transform = fitTreeTransform(
    TREE,
    folded,
    "",
    { width: 800, height: 500 },
  );
  const visible = buildVisibleTree(TREE, folded, "");
  const layout = layoutTree(visible.root);

  assert.equal(transform.x, 20);
  assert.equal(transform.y, 20);
  assert(transform.scale >= 0.35);
  assert(transform.scale <= 1.4);
  assert(layout.width * transform.scale <= 760);
  assert(layout.height * transform.scale <= 460);
});
```

- [ ] **Step 5: Run the fitted-transform test and verify RED**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs --test-name-pattern="fitted overview"
```

Expected: FAIL because `fitTreeTransform` is not exported.

- [ ] **Step 6: Extract the existing fit calculation into the shared model**

Add to `web/model.mjs`:

```js
export function fitTreeTransform(root, folded, query, stage) {
  const visible = buildVisibleTree(root, folded, query);
  const layout = layoutTree(visible.root);
  const availableWidth = Math.max(200, stage.width - 40);
  const availableHeight = Math.max(160, stage.height - 40);
  return {
    x: 20,
    y: 20,
    scale: Math.max(
      0.35,
      Math.min(
        1.4,
        availableWidth / layout.width,
        availableHeight / layout.height,
      ),
    ),
  };
}
```

Replace the duplicated calculation in `app.mjs`:

```js
function fitView() {
  if (!lastTree?.root) return;
  transform = fitTreeTransform(
    lastTree.root,
    folded,
    query,
    { width: stage.clientWidth, height: stage.clientHeight },
  );
  setTransform();
}
```

- [ ] **Step 7: Apply one-time initialization in `applySnapshot`**

Add app state:

```js
let initializedBindingId = null;
```

In `applySnapshot(next)`, calculate the effective binding before mutating
`bindingId`:

```js
const nextBindingId = next.bindingId ?? bindingId;
if (bindingChanged(bindingId, nextBindingId)) {
  lastTree = null;
  folded = new Set();
  query = "";
  searchInput.value = "";
}
bindingId = nextBindingId;
```

In the valid-tree branch:

```js
const initializeOverview = needsOverviewInitialization(
  initializedBindingId,
  bindingId,
  next.tree.root,
);
folded = initializeOverview
  ? initialOverviewFolds(next.tree.root)
  : reconcileFoldState(folded, next.tree.root);
lastTree = next.tree;
emptyState.hidden = true;
canvas.hidden = false;
renderTree();
if (initializeOverview) {
  initializedBindingId = bindingId;
  fitView();
}
```

Do not set `initializedBindingId` in missing, empty, invalid, or terminal
branches. Do not reset it merely because a temporary same-binding refresh
failed. A later valid tree for a different binding compares unequal and
initializes normally.

- [ ] **Step 8: Add an app-build contract test**

Extend the existing build test in `tests/server.test.mjs` to assert both
generated presentations contain the initialization behavior:

```js
assert.match(widgetHtml, /initialOverviewFolds/);
assert.match(standaloneApp, /initialOverviewFolds/);
assert.match(widgetHtml, /fitTreeTransform/);
assert.match(standaloneApp, /fitTreeTransform/);
```

If minification removes exported names, add a stable source-level assertion
that `app.mjs` imports and calls both functions, while retaining the generated
asset existence checks. Do not disable minification solely to preserve names.

- [ ] **Step 9: Run focused and full verification**

Run:

```bash
cd plugins/context-map-viewer
node --test tests/web-model.test.mjs tests/server.test.mjs
npm test
npm run build
git diff --check
cd ../..
npm test
npm pack --dry-run --cache /private/tmp/handoff-npm-cache
```

Expected:

- all model and server tests pass;
- all Viewer tests pass, with loopback tests rerun under the existing
  `127.0.0.1` permission when the sandbox reports `EPERM`;
- root Node suite passes with only the existing Deno-unavailable skip;
- package dry-run includes regenerated inline and standalone assets;
- `git diff --check` prints nothing;
- untracked root `package-lock.json` remains unstaged.

- [ ] **Step 10: Perform manual side-browser acceptance**

1. Start the updated standalone build against a representative large Context
   Map.
2. Open the returned session URL in the Codex in-app side browser.
3. Verify the first screen shows the root and semantic sections, while their
   descendants are hidden.
4. Verify the zoom value reflects an automatic Fit.
5. Expand one section and confirm its descendants appear.
6. Wait for a same-binding refresh and confirm the section and viewport remain
   as the user left them.

- [ ] **Step 11: Commit**

```bash
git add \
  plugins/context-map-viewer/web/model.mjs \
  plugins/context-map-viewer/web/app.mjs \
  plugins/context-map-viewer/tests/web-model.test.mjs \
  plugins/context-map-viewer/tests/server.test.mjs \
  plugins/context-map-viewer/dist/widget.html \
  plugins/context-map-viewer/dist/standalone/app.mjs \
  plugins/context-map-viewer/dist/standalone/model.mjs
git commit -m "fix(viewer): open with a fitted section overview"
```

## Final Review Gate

- [ ] Confirm the initial fold set contains only top-level sections with children.
- [ ] Confirm the root and all semantic sections stay visible.
- [ ] Confirm invalid initial snapshots do not consume initialization.
- [ ] Confirm same-binding refreshes preserve user fold and viewport state.
- [ ] Confirm new bindings reinitialize independently.
- [ ] Confirm inline and standalone builds contain the same behavior.
- [ ] Confirm the untracked root `package-lock.json` remains untouched.
