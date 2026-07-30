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
