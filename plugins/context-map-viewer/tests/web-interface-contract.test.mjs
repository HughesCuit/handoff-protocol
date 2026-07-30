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
