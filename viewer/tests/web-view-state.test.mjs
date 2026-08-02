import assert from "node:assert/strict";
import test from "node:test";

import * as model from "../web/model.mjs";

const STAGE = { width: 800, height: 500 };
const FITTED_OVERVIEW = { x: 20, y: 20, scale: 1.4 };
const TREE = {
  root: {
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
        ],
      },
      {
        id: "risks",
        text: "Risks",
        children: [{ id: "size", text: "Large maps", children: [] }],
      },
    ],
  },
};

function viewStateController() {
  assert.equal(
    typeof model.createViewState,
    "function",
    "production must expose the app's initial view-state model",
  );
  assert.equal(
    typeof model.transitionSnapshotViewState,
    "function",
    "production must expose the app's snapshot transition",
  );
  return {
    create: model.createViewState,
    transition: model.transitionSnapshotViewState,
  };
}

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

test("missing or invalid retained trees wait for a synced snapshot to initialize", () => {
  const controller = viewStateController();

  for (const status of ["missing", "invalid"]) {
    let state = controller.create();
    state = controller.transition(state, {
      bindingId: "workspace-a",
      status,
      tree: structuredClone(TREE),
    }, STAGE);

    assert.equal(state.overviewPending, true, status);
    assert.deepEqual([...state.folded], [], status);
    assert.deepEqual(state.transform, { x: 36, y: 36, scale: 1 }, status);

    state = controller.transition(state, {
      bindingId: "workspace-a",
      status: "synced",
      tree: structuredClone(TREE),
    }, STAGE);

    assert.equal(state.overviewPending, false, status);
    assert.deepEqual([...state.folded], ["tasks", "risks"], status);
    assert.deepEqual(state.transform, FITTED_OVERVIEW, status);
  }
});

test("A to B error-only to A scopes initialization to each effective binding", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  state = {
    ...state,
    folded: new Set(["build"]),
    query: "tasks svg",
    transform: { x: 141, y: -23, scale: 0.82 },
  };

  state = controller.transition(state, {
    bindingId: "workspace-b",
    status: "invalid",
    tree: null,
  }, STAGE);

  assert.equal(state.bindingId, "workspace-b");
  assert.equal(state.tree, null);
  assert.equal(state.overviewPending, true);
  assert.deepEqual([...state.folded], []);
  assert.equal(state.query, "");

  state = controller.transition(state, {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);

  assert.equal(state.overviewPending, false);
  assert.deepEqual([...state.folded], ["tasks", "risks"]);
  assert.deepEqual(state.transform, FITTED_OVERVIEW);
});

test("same-binding errors and synced refreshes preserve user view state", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  const userTransform = { x: 137, y: -29, scale: 0.82 };
  state = {
    ...state,
    folded: new Set(["build"]),
    query: "tasks svg",
    transform: userTransform,
  };

  state = controller.transition(state, {
    bindingId: "workspace-a",
    status: "invalid",
    tree: structuredClone(TREE),
  }, STAGE);

  assert.equal(state.overviewPending, false);
  assert.deepEqual([...state.folded], ["build"]);
  assert.equal(state.query, "tasks svg");
  assert.deepEqual(state.transform, userTransform);

  const refreshedTree = structuredClone(TREE);
  refreshedTree.root.children[1].children.push({
    id: "latency",
    text: "Slow refresh",
    children: [],
  });
  state = controller.transition(state, {
    bindingId: "workspace-a",
    status: "synced",
    tree: refreshedTree,
  }, STAGE);

  assert.equal(state.overviewPending, false);
  assert.deepEqual([...state.folded], ["build"]);
  assert.equal(state.query, "tasks svg");
  assert.deepEqual(state.transform, userTransform);
  assert.equal(state.tree.root.children[1].children.at(-1).id, "latency");
});

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

test("a valid new binding folds and fits its first synced tree", () => {
  const controller = viewStateController();
  let state = controller.transition(controller.create(), {
    bindingId: "workspace-a",
    status: "synced",
    tree: structuredClone(TREE),
  }, STAGE);
  state = {
    ...state,
    folded: new Set(["build"]),
    query: "tasks svg",
    transform: { x: 211, y: 87, scale: 2.1 },
  };

  const nextTree = structuredClone(TREE);
  nextTree.root.id = "root-b";
  state = controller.transition(state, {
    bindingId: "workspace-b",
    status: "synced",
    tree: nextTree,
  }, STAGE);

  assert.equal(state.bindingId, "workspace-b");
  assert.equal(state.overviewPending, false);
  assert.deepEqual([...state.folded], ["tasks", "risks"]);
  assert.equal(state.query, "");
  assert.deepEqual(state.transform, FITTED_OVERVIEW);
});
