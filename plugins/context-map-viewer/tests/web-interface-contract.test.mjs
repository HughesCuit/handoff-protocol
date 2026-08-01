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

test("map interactions measure the visible map pane before rendering or transforming", async () => {
  const app = await source("web/app.mjs");
  assert.match(app, /function mapViewport\(\)[\s\S]*mapPane\.clientWidth[\s\S]*mapPane\.clientHeight/);
  assert.match(app, /transitionSnapshotViewState\([\s\S]*mapViewport\(\)/);
  assert.match(app, /fitTreeTransform\([\s\S]*mapViewport\(\)/);
  assert.match(app, /function zoomAt\(factor, centerX = mapPane\.clientWidth \/ 2, centerY = mapPane\.clientHeight \/ 2\)/);
  assert.match(app, /const rect = mapPane\.getBoundingClientRect\(\)/);
  assert.match(app, /function renderAllViews[\s\S]*renderDisplayMode\(\);[\s\S]*renderNavigationTree\(\);[\s\S]*if \(mapIsVisible\(\)\) renderMap/);
  assert.match(app, /function applySnapshot[\s\S]*renderDisplayMode\(nextDisplayMode\);[\s\S]*transitionSnapshotViewState[\s\S]*mapViewport\(\)[\s\S]*renderDisplayMode\(\);/);
  assert.match(app, /if \(!mapIsVisible\(\)\) return;/);
});

test("responsive toolbar styles wrap controls within narrow viewports", async () => {
  const css = await source("web/styles.css");
  assert.match(css, /\.toolbar\s*\{[\s\S]*flex-wrap: wrap/);
  assert.match(css, /@media \(max-width: 559px\)[\s\S]*\.search\s*\{[\s\S]*flex-basis: 100%/);
});

test("selection expands ancestors, focuses the map, and details render authoritative text", async () => {
  const app = await source("web/app.mjs");
  assert.match(
    app,
    /function selectNode\(\s*nodeId,\s*source,\s*returnFocus = document\.activeElement,?\s*\)/,
  );
  assert.match(app, /expandAncestors\(viewState\.folded, nodeId,/);
  assert.match(app, /focusNodeTransform\(/);
  assert.match(app, /function renderDetails\(\)/);
  assert.match(app, /detailsText\.textContent = selected\.node\.text/);
  assert.match(app, /class: "node-disclosure"/);
  assert.match(app, /class: "node-body"/);
});

test("details focus return resolves a stable node descriptor after rerenders", async () => {
  const app = await source("web/app.mjs");
  assert.match(
    app,
    /detailsReturnFocus = \{\s*source: returnSource,\s*nodeId,\s*\}/s,
  );
  assert.match(app, /function resolveDetailsReturnFocus\(\)/);
  assert.match(
    app,
    /element\.dataset\.nodeId === detailsReturnFocus\.nodeId/,
  );
  assert.match(app, /const returnFocus = resolveDetailsReturnFocus\(\)/);
  assert.doesNotMatch(app, /detailsReturnFocus\?\.[\s\S]*isConnected/);
});

test("tree supports roving keyboard focus and details restore focus", async () => {
  const app = await source("web/app.mjs");
  assert.match(app, /function moveTreeFocus\(currentId, direction\)/);
  assert.match(app, /case "ArrowDown"/);
  assert.match(app, /case "ArrowUp"/);
  assert.match(app, /case "ArrowRight"/);
  assert.match(app, /case "ArrowLeft"/);
  assert.match(app, /const returnFocus = resolveDetailsReturnFocus\(\)/);
  assert.match(app, /returnFocus\?\.isConnected/);
});

test("tree focus resets across bindings and keeps disclosures out of the tab sequence", async () => {
  const app = await source("web/app.mjs");
  assert.match(
    app,
    /previousBindingId !== viewState\.bindingId[\s\S]*treeFocusId = null/,
  );
  assert.match(app, /disclosure\.tabIndex = -1/);
  assert.match(
    app,
    /toggleFold\(node\.id\);\s*focusTreeItem\(node\.id\);/,
  );
});

test("details styling is an overlay and compact mode becomes full width", async () => {
  const css = await source("web/styles.css");
  assert.match(css, /\.details-drawer\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.details-drawer\s*\{[^}]*right:\s*0/s);
  assert.match(css, /@media \(max-width: 419px\)[\s\S]*\.details-drawer[\s\S]*width:\s*100%/);
});
