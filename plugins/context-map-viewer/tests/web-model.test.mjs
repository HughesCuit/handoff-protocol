import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisibleTree,
  collapseAll,
  layoutTree,
  matchSearch,
  reconcileFoldState,
  requestPictureInPicture,
} from "../web/model.mjs";

const TREE = {
  id: "root",
  text: "Context Map",
  children: [
    {
      id: "tasks",
      text: "Tasks",
      children: [
        {
          id: "build",
          text: "Build viewer",
          children: [{ id: "svg", text: "Use SVG canvas", children: [] }],
        },
        { id: "docs", text: "Write documentation", children: [] },
      ],
    },
    {
      id: "risks",
      text: "Risks",
      children: [{ id: "size", text: "Large maps", children: [] }],
    },
  ],
};

test("folded descendants are excluded and collapse-all keeps sections visible", () => {
  const folded = collapseAll(TREE);
  assert.deepEqual([...folded], ["tasks", "risks"]);

  const visible = buildVisibleTree(TREE, folded, "");
  assert.deepEqual(visible.root.children.map((node) => node.id), ["tasks", "risks"]);
  assert.deepEqual(visible.root.children[0].children, []);
});

test("search matches ancestor paths and temporarily reveals folded ancestors", () => {
  const search = matchSearch(TREE, "tasks svg");
  assert.deepEqual([...search.matches], ["svg"]);
  assert.deepEqual([...search.ancestors], ["root", "tasks", "build"]);

  const visible = buildVisibleTree(TREE, new Set(["tasks", "build"]), "tasks svg");
  assert.equal(visible.root.children[0].children[0].children[0].id, "svg");
  assert.equal(visible.matches.has("svg"), true);
});

test("fold state keeps only ids that survive a refresh", () => {
  const next = structuredClone(TREE);
  next.children[0].children[0].id = "build-edited";

  const reconciled = reconcileFoldState(new Set(["tasks", "build", "gone"]), next);

  assert.deepEqual([...reconciled], ["tasks"]);
});

test("horizontal layout is deterministic and preserves child order", () => {
  const first = layoutTree(TREE);
  const second = layoutTree(TREE);

  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes.map((node) => node.id), [
    "root",
    "tasks",
    "build",
    "svg",
    "docs",
    "risks",
    "size",
  ]);
  assert(first.nodes.find((node) => node.id === "svg").x >
    first.nodes.find((node) => node.id === "build").x);
  assert(first.nodes.find((node) => node.id === "docs").y >
    first.nodes.find((node) => node.id === "build").y);
});

test("picture-in-picture request tolerates missing, synchronous, and rejected hosts", async () => {
  assert.equal(await requestPictureInPicture(undefined), false);
  assert.equal(await requestPictureInPicture({ requestDisplayMode: () => undefined }), true);
  assert.equal(await requestPictureInPicture({
    requestDisplayMode: () => Promise.reject(new Error("unsupported")),
  }), false);
});
