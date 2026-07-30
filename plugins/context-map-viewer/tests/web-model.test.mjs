import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisibleTree,
  collapseAll,
  focusNodeTransform,
  fitTreeTransform,
  initialOverviewFolds,
  bindingChanged,
  layoutTree,
  matchSearch,
  needsOverviewInitialization,
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

test("overview initialization requires a pending synced tree", () => {
  assert.equal(needsOverviewInitialization(true, "a", "missing", TREE), false);
  assert.equal(needsOverviewInitialization(true, "a", "synced", null), false);
  assert.equal(needsOverviewInitialization(true, "a", "synced", TREE), true);
  assert.equal(needsOverviewInitialization(false, "a", "synced", TREE), false);
});

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

test("search focus centers the first matching node without changing zoom", () => {
  const layout = layoutTree(TREE);
  const next = focusNodeTransform(
    layout,
    "svg",
    { width: 800, height: 600 },
    { x: 10, y: 20, scale: 1.25 },
  );
  const node = layout.nodes.find((item) => item.id === "svg");

  assert.equal(next.scale, 1.25);
  assert.equal(next.x + (node.x + node.width / 2) * next.scale, 400);
  assert.equal(next.y + (node.y + node.height / 2) * next.scale, 300);
});

test("binding changes distinguish workspace switches from same-workspace refreshes", () => {
  assert.equal(bindingChanged(null, "workspace-a"), false);
  assert.equal(bindingChanged("workspace-a", "workspace-a"), false);
  assert.equal(bindingChanged("workspace-a", "workspace-b"), true);
  assert.equal(bindingChanged("workspace-a", null), true);
  assert.equal(bindingChanged("workspace-a", "no-workspace"), true);
});

test("picture-in-picture request tolerates missing, synchronous, and rejected hosts", async () => {
  assert.equal(await requestPictureInPicture(undefined), false);
  assert.equal(await requestPictureInPicture({ requestDisplayMode: () => undefined }), true);
  assert.equal(await requestPictureInPicture({
    requestDisplayMode: () => Promise.reject(new Error("unsupported")),
  }), false);
});
