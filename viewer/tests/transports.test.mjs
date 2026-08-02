import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createPageLifecycle,
} from "../web/transports.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function validSnapshot(overrides = {}) {
  return {
    status: "synced",
    version: "v1",
    tree: {
      root: {
        id: "context-map",
        section: "root",
        text: "Context Map",
        taskState: null,
        risk: null,
        excluded: false,
        origin: "user",
        children: [],
      },
      nodeCount: 1,
    },
    nodeCount: 1,
    diagnostic: null,
    watchMode: "watch",
    watchDiagnostic: null,
    bindingId: "binding-1",
    source: ".handoff/context-map.md",
    ...overrides,
  };
}

function lifecycleHarness(overrides = {}) {
  const timers = new Map();
  let nextTimerId = 1;
  const snapshots = [];
  const statuses = [];
  const terminals = [];
  const lifecycle = createPageLifecycle({
    initialSnapshot: async () => ({ status: "initial" }),
    refresh: async () => ({ status: "synced" }),
    applySnapshot: (snapshot) => {
      snapshots.push(snapshot);
      statuses.push(snapshot.status);
    },
    setStatus: (status) => statuses.push(status),
    terminal: (message) => terminals.push(message),
    fallbackStatus: () => "invalid",
    isHidden: () => false,
    setInterval: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    ...overrides,
  });
  return { lifecycle, snapshots, statuses, terminals, timers };
}

test("HTTP transport reads only the same-origin session API", async () => {
  const calls = [];
  const expected = validSnapshot();
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async (url, options) => {
      calls.push([String(url), options]);
      return new Response(JSON.stringify(expected));
    },
  });

  assert.deepEqual(await transport.initialSnapshot(), expected);
  assert.equal(calls[0][0], "http://127.0.0.1:4312/session/token/api/context-map");
  assert.deepEqual(calls[0][1], {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
});

test("HTTP transport accepts the parser's production semantic sections", async () => {
  const expected = validSnapshot({
    tree: {
      root: {
        id: "context-map",
        section: "root",
        text: "Context Map",
        taskState: null,
        risk: null,
        excluded: false,
        origin: "user",
        children: [{
          id: "section-goal",
          section: "goal",
          text: "Current Goal",
          taskState: null,
          risk: null,
          excluded: false,
          origin: "user",
          children: [{
            id: "goal-item",
            section: "goal",
            text: "Keep the session bound",
            taskState: null,
            risk: null,
            excluded: false,
            origin: "user",
            children: [],
          }],
        }],
      },
      nodeCount: 1,
    },
  });
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async () => new Response(JSON.stringify(expected)),
  });

  assert.deepEqual(await transport.refresh(), expected);
});

test("HTTP transport reports an expired session without changing endpoint", async () => {
  const calls = [];
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async (url) => {
      calls.push(String(url));
      return new Response("", { status: 404 });
    },
  });

  await assert.rejects(() => transport.refresh(), /SESSION_EXPIRED/);
  assert.deepEqual(calls, ["http://127.0.0.1:4312/session/token/api/context-map"]);
});

test("HTTP transport rejects primitive and structurally invalid snapshot payloads", async () => {
  const invalidPayloads = [
    null,
    7,
    "synced",
    [],
    {},
    validSnapshot({ status: "unknown" }),
    validSnapshot({ version: 1 }),
    validSnapshot({ tree: [] }),
    validSnapshot({ tree: null }),
    validSnapshot({ nodeCount: "1" }),
    validSnapshot({ diagnostic: {} }),
    validSnapshot({ watchMode: "filesystem" }),
    validSnapshot({ source: "/private/workspace/.handoff/context-map.md" }),
  ];

  for (const payload of invalidPayloads) {
    const transport = createHttpTransport({
      location: new URL("http://127.0.0.1:4312/session/token/"),
      fetch: async () => new Response(JSON.stringify(payload)),
    });
    await assert.rejects(
      () => transport.refresh(),
      /INVALID_SNAPSHOT/,
      `accepted malformed payload: ${JSON.stringify(payload)}`,
    );
  }
});

test("malformed HTTP refresh retains the last valid map and restores its status", async () => {
  const expected = validSnapshot();
  const responses = [expected, 42];
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async () => new Response(JSON.stringify(responses.shift())),
  });
  let lastValid = null;
  const harness = lifecycleHarness({
    initialSnapshot: () => transport.initialSnapshot(),
    refresh: () => transport.refresh(),
    applySnapshot(snapshot) {
      lastValid = snapshot;
      harness.snapshots.push(snapshot);
      harness.statuses.push(snapshot.status);
    },
    fallbackStatus: () => lastValid?.status ?? "invalid",
  });

  await harness.lifecycle.start();
  await harness.lifecycle.refresh();

  assert.deepEqual(harness.snapshots, [expected]);
  assert.equal(lastValid.tree.root.text, "Context Map");
  assert.equal(harness.statuses.at(-1), "synced");
});

test("page lifecycle never applies an in-flight refresh over a newer incoming snapshot", async () => {
  const pending = deferred();
  const harness = lifecycleHarness({
    refresh: () => pending.promise,
  });
  await harness.lifecycle.start();

  const refresh = harness.lifecycle.refresh();
  harness.lifecycle.applyIncomingSnapshot({ status: "synced", version: "newer" });
  pending.resolve({ status: "synced", version: "stale" });
  await refresh;

  assert.deepEqual(harness.snapshots, [
    { status: "initial" },
    { status: "synced", version: "newer" },
  ]);
});

test("page lifecycle keeps refresh polling single-flight and continues after a slow response", async () => {
  const slow = deferred();
  let reads = 0;
  const harness = lifecycleHarness({
    refresh() {
      reads += 1;
      return reads === 1
        ? slow.promise
        : Promise.resolve({ status: "synced", version: "next" });
    },
  });
  await harness.lifecycle.start();

  const first = harness.lifecycle.refresh();
  const overlapping = harness.lifecycle.refresh();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(harness.statuses.at(-1), "refreshing");

  slow.resolve({ status: "synced", version: "slow" });
  await Promise.all([first, overlapping]);
  assert.deepEqual(harness.snapshots.at(-1), { status: "synced", version: "slow" });

  const poll = [...harness.timers.values()][0];
  await poll();
  assert.equal(reads, 2);
  assert.deepEqual(harness.snapshots.at(-1), { status: "synced", version: "next" });
  assert.equal(harness.statuses.at(-1), "synced");
});

test("page lifecycle keeps one poll timer when visibility returns during initialization", async () => {
  const initial = deferred();
  const harness = lifecycleHarness({
    initialSnapshot: () => initial.promise,
    refresh: async () => ({ status: "synced", version: "refresh" }),
  });

  const starting = harness.lifecycle.start();
  await harness.lifecycle.visibilityChanged(false);
  initial.resolve({ status: "synced", version: "initial" });
  await starting;

  assert.deepEqual(harness.snapshots, [{ status: "synced", version: "refresh" }]);
  assert.equal(harness.timers.size, 1);
});

test("page lifecycle cannot start polling after disposal while initialization is pending", async () => {
  const initial = deferred();
  const harness = lifecycleHarness({ initialSnapshot: () => initial.promise });

  const starting = harness.lifecycle.start();
  harness.lifecycle.dispose();
  initial.resolve({ status: "synced" });
  await starting;

  assert.deepEqual(harness.snapshots, []);
  assert.equal(harness.timers.size, 0);
});

// ── v3 lazy node detail transport ────────────────────────────────────────────

import { loadNode } from "../web/transports.mjs";

const SESSION_BASE = "http://127.0.0.1:4312/session/token/";

function nodeDetail(overrides = {}) {
  return {
    id: "task1",
    section: "tasks",
    label: "Wire lazy node details",
    summary: "Lazy detail summary.",
    body: "Lazy detail **body**.",
    version: "v123",
    diagnostic: null,
    ...overrides,
  };
}

test("loadNode resolves a valid detail from node/<id>", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    return new Response(JSON.stringify(nodeDetail()));
  };
  const detail = await loadNode(SESSION_BASE, "task1", undefined, fetchImpl);
  assert.equal(detail.id, "task1");
  assert.equal(detail.body, "Lazy detail **body**.");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/session/token/node/task1"), `unexpected url: ${calls[0]}`);
});

test("loadNode rejects an ID that does not match the response", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(nodeDetail({ id: "task2" })));
  await assert.rejects(
    () => loadNode(SESSION_BASE, "task1", undefined, fetchImpl),
    /INVALID_NODE_DETAIL/,
  );
});

test("loadNode rejects a detail missing its version", async () => {
  const fetchImpl = async () => new Response(JSON.stringify(nodeDetail({ version: undefined })));
  await assert.rejects(
    () => loadNode(SESSION_BASE, "task1", undefined, fetchImpl),
    /INVALID_NODE_DETAIL/,
  );
});

test("loadNode maps 404 to NODE_NOT_FOUND and 409 to MIGRATION_REQUIRED", async () => {
  await assert.rejects(
    () => loadNode(SESSION_BASE, "task99", undefined, async () => new Response("", { status: 404 })),
    /NODE_NOT_FOUND/,
  );
  await assert.rejects(
    () => loadNode(SESSION_BASE, "task1", undefined, async () => new Response("", { status: 409 })),
    /MIGRATION_REQUIRED/,
  );
});

test("loadNode rejects an invalid ID grammar without fetching", async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return new Response(JSON.stringify(nodeDetail()));
  };
  for (const bad of ["foo", "TASK1", "task0", "task-1", "../task1"]) {
    await assert.rejects(() => loadNode(SESSION_BASE, bad, undefined, fetchImpl), /ID_INVALID/);
  }
  assert.equal(fetched, false, "invalid IDs must never reach the network");
});

test("loadNode forwards the abort signal", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const fetchImpl = async (url, init) => {
    receivedSignal = init.signal;
    return new Response(JSON.stringify(nodeDetail()));
  };
  await loadNode(SESSION_BASE, "task1", controller.signal, fetchImpl);
  assert.equal(receivedSignal, controller.signal);
});
