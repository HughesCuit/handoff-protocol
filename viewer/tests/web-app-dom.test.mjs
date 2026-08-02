import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Window } from "happy-dom";

const template = await readFile(
  new URL("../web/standalone.html", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/styles.css", import.meta.url),
  "utf8",
);
const appUrl = new URL("../web/app.mjs", import.meta.url);
let appInstance = 0;

const TREE = {
  root: {
    id: "root",
    section: "root",
    text: "Context Map",
    taskState: null,
    risk: null,
    excluded: false,
    origin: "user",
    children: [
      {
        id: "tasks",
        section: "tasks",
        text: "Tasks",
        taskState: null,
        risk: null,
        excluded: false,
        origin: "user",
        children: [
          {
            id: "build",
            section: "tasks",
            text: "Build viewer",
            taskState: "open",
            risk: null,
            excluded: false,
            origin: "agent",
            children: [
              {
                id: "svg",
                section: "tasks",
                text: "Use SVG canvas",
                taskState: "open",
                risk: null,
                excluded: false,
                origin: "agent",
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "risks",
        section: "risks",
        text: "Risks",
        taskState: null,
        risk: null,
        excluded: false,
        origin: "user",
        children: [
          {
            id: "size",
            section: "risks",
            text: "Large maps",
            taskState: null,
            risk: "high",
            excluded: false,
            origin: "user",
            children: [],
          },
        ],
      },
      {
        id: "long",
        section: "knowledge",
        text: "A long node label that opens details",
        taskState: null,
        risk: null,
        excluded: false,
        origin: "user",
        children: [],
      },
    ],
  },
  nodeCount: 7,
};

function snapshot(overrides = {}) {
  return {
    status: "synced",
    version: "v1",
    tree: structuredClone(TREE),
    nodeCount: TREE.nodeCount,
    diagnostic: null,
    watchMode: "watch",
    watchDiagnostic: null,
    bindingId: "binding-1",
    source: ".handoff/context-map.md",
    ...overrides,
  };
}

async function waitFor(predicate, message, timeoutMs = 1_200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

async function openViewer({
  fetchSnapshot = async () => new Response(JSON.stringify(snapshot())),
  width = 612,
  mapLeft = 220,
  mapWidth = 392,
} = {}) {
  const window = new Window({
    url: "http://127.0.0.1:4312/session/token/",
  });
  window.document.write(template);
  const style = window.document.createElement("style");
  style.textContent = styles;
  window.document.head.append(style);
  window.fetch = fetchSnapshot;
  const intervalCallbacks = new Map();
  let nextIntervalId = 1;
  window.setInterval = (callback) => {
    const id = nextIntervalId++;
    intervalCallbacks.set(id, callback);
    return id;
  };
  window.clearInterval = (id) => intervalCallbacks.delete(id);
  const layout = { width, mapLeft, mapWidth };
  const stage = window.document.getElementById("stage");
  const mapPane = window.document.getElementById("map-pane");

  const rect = (left, rectWidth, height = 500) => ({
    x: left,
    y: 0,
    top: 0,
    right: left + rectWidth,
    bottom: height,
    left,
    width: rectWidth,
    height,
    toJSON() {
      return this;
    },
  });
  Object.defineProperties(stage, {
    clientWidth: { configurable: true, get: () => layout.width },
    clientHeight: { configurable: true, get: () => 500 },
  });
  Object.defineProperties(mapPane, {
    clientWidth: { configurable: true, get: () => layout.mapWidth },
    clientHeight: { configurable: true, get: () => 500 },
  });
  stage.getBoundingClientRect = () => rect(0, layout.width);
  mapPane.getBoundingClientRect = () => rect(layout.mapLeft, layout.mapWidth);
  window.happyDOM.setWindowSize({ width, height: 700 });

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = window;
  globalThis.document = window.document;
  await import(`${appUrl.href}?instance=${appInstance++}`);
  await waitFor(
    () => window.document.getElementById("sync-status").textContent === "Synced",
    "viewer did not apply its initial snapshot",
  );

  return {
    window,
    document: window.document,
    layout,
    async poll() {
      const callbacks = [...intervalCallbacks.values()];
      assert.equal(callbacks.length, 1, "viewer should own one active poll timer");
      await callbacks[0]();
    },
    cleanup() {
      window.dispatchEvent(new window.Event("pagehide"));
      window.close();
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    },
  };
}

test("same-binding polls preserve the focused details opener and tree item", { concurrency: false }, async (t) => {
  let reads = 0;
  const viewer = await openViewer({
    fetchSnapshot: async () => {
      reads += 1;
      return new Response(JSON.stringify(snapshot()));
    },
  });
  t.after(() => viewer.cleanup());

  viewer.document.querySelector('.tree-label[data-node-id="long"]').click();
  click(viewer.window, viewer.document.getElementById("details-close"));
  await Promise.resolve();
  const opener = viewer.document.querySelector(
    '.tree-label[data-node-id="long"]',
  );
  assert.equal(viewer.document.activeElement === opener, true);

  await viewer.poll();
  assert.equal(reads, 2);
  assert.equal(viewer.document.activeElement === opener, true);
  assert.equal(opener.isConnected, true);

  const treeItem = viewer.document.querySelector(
    '.tree-label[data-node-id="tasks"]',
  );
  treeItem.focus();
  await viewer.poll();
  assert.equal(reads, 3);
  assert.equal(viewer.document.activeElement === treeItem, true);
  assert.equal(treeItem.isConnected, true);
});

test("session expiry clears open details, selection, and focus before showing terminal state", { concurrency: false }, async (t) => {
  let reads = 0;
  const viewer = await openViewer({
    fetchSnapshot: async () => {
      reads += 1;
      return reads === 1
        ? new Response(JSON.stringify(snapshot()))
        : new Response("", { status: 404 });
    },
  });
  t.after(() => viewer.cleanup());

  click(
    viewer.window,
    viewer.document.querySelector('.node-body[data-node-id="tasks"]'),
  );
  assert.equal(viewer.document.getElementById("details-drawer").hidden, false);
  assert.equal(viewer.document.getElementById("details-text").textContent, "Tasks");

  await viewer.poll();
  assert.equal(
    viewer.document.getElementById("sync-status").textContent,
    "Session expired",
  );

  const emptyState = viewer.document.getElementById("empty-state");
  assert.equal(viewer.document.getElementById("details-drawer").hidden, true);
  assert.equal(viewer.document.getElementById("details-text").textContent, "");
  assert.equal(viewer.document.querySelector('[aria-current="true"]'), null);
  assert.equal(viewer.document.activeElement === emptyState, true);
});

test("map selection exposes current state and drawer bounds stay inside the map pane", { concurrency: false }, async (t) => {
  const viewer = await openViewer({ width: 520, mapLeft: 180, mapWidth: 340 });
  t.after(() => viewer.cleanup());

  click(
    viewer.window,
    viewer.document.querySelector('.node-body[data-node-id="tasks"]'),
  );
  const selected = viewer.document.querySelector(
    '.node-body[data-node-id="tasks"]',
  );
  const drawer = viewer.document.getElementById("details-drawer");
  assert.equal(selected.getAttribute("aria-current"), "true");
  assert.equal(
    viewer.document.querySelector('.node-body[data-node-id="risks"]')
      .getAttribute("aria-current"),
    "false",
  );
  assert.equal(drawer.style.left, "180px");
  assert.equal(drawer.style.width, "340px");
  assert.equal(
    viewer.window.getComputedStyle(drawer).boxSizing,
    "border-box",
  );

  viewer.layout.width = 800;
  viewer.layout.mapLeft = 220;
  viewer.layout.mapWidth = 580;
  viewer.window.happyDOM.setWindowSize({ width: 800, height: 700 });
  viewer.window.dispatchEvent(new viewer.window.Event("resize"));
  assert.equal(drawer.style.left, "440px");
  assert.equal(drawer.style.width, "360px");

  viewer.layout.width = 390;
  viewer.layout.mapLeft = 0;
  viewer.layout.mapWidth = 390;
  viewer.window.happyDOM.setWindowSize({ width: 390, height: 700 });
  viewer.window.dispatchEvent(new viewer.window.Event("resize"));
  assert.equal(drawer.style.left, "0px");
  assert.equal(drawer.style.width, "390px");
});

test("tree search highlights matches and defers map focus until Map is measurable", { concurrency: false }, async (t) => {
  const viewer = await openViewer();
  t.after(() => viewer.cleanup());

  viewer.document.getElementById("mode-tree").click();
  const before = viewer.document.getElementById("viewport").getAttribute("transform");
  const search = viewer.document.getElementById("search");
  search.value = "Large maps";
  search.dispatchEvent(new viewer.window.Event("input"));

  const match = viewer.document.querySelector('.tree-item[data-node-id="size"]');
  assert.equal(match.classList.contains("match"), true);

  viewer.document.getElementById("mode-map").click();
  const after = viewer.document.getElementById("viewport").getAttribute("transform");
  assert.notEqual(after, before);
  assert.equal(
    after.match(/scale\(([^)]+)\)/)?.[1],
    before.match(/scale\(([^)]+)\)/)?.[1],
  );
});

test("tree selection retains its map focus target until Map is measurable", { concurrency: false }, async (t) => {
  const viewer = await openViewer();
  t.after(() => viewer.cleanup());

  viewer.document.getElementById("mode-tree").click();
  const before = viewer.document.getElementById("viewport").getAttribute("transform");
  viewer.document.querySelector('.tree-label[data-node-id="risks"]').click();
  assert.equal(
    viewer.document.getElementById("viewport").getAttribute("transform"),
    before,
  );

  viewer.document.getElementById("mode-map").click();
  const after = viewer.document.getElementById("viewport").getAttribute("transform");
  assert.notEqual(after, before);
  assert.equal(
    after.match(/scale\(([^)]+)\)/)?.[1],
    before.match(/scale\(([^)]+)\)/)?.[1],
  );
});
