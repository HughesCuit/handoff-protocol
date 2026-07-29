import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSessionManager } from "../server/browser-session-manager.mjs";

function fakeStore(calls = [], closed = []) {
  return {
    async bind(rootUri) {
      calls.push(["bind", rootUri]);
    },
    async refresh() {},
    snapshot() {
      return { status: "synced" };
    },
    async close() {
      closed.push(this);
    },
  };
}

function deterministicManager(options = {}) {
  let byte = 1;
  return new BrowserSessionManager({
    randomBytes: () => Buffer.alloc(24, byte++),
    createStore: () => fakeStore(),
    ...options,
  });
}

test("creates an opaque session permanently bound to one workspace", async () => {
  const calls = [];
  const stores = [];
  const manager = new BrowserSessionManager({
    randomBytes: () => Buffer.alloc(24, 7),
    createStore: () => {
      const store = fakeStore(calls);
      stores.push(store);
      return store;
    },
  });

  const created = await manager.create("/workspace/alpha");

  assert.match(created.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(created.source, ".handoff/context-map.md");
  assert.deepEqual(calls, [["bind", "file:///workspace/alpha"]]);
  assert.equal((await manager.touch(created.token)).store, stores[0]);
  assert.equal((await manager.touch(created.token)).workspaceRoot, undefined);
  await manager.close();
});

test("rejects a relative workspace before retaining a session", async () => {
  const manager = new BrowserSessionManager();

  await assert.rejects(() => manager.create("../alpha"), /absolute workspace/i);
  assert.equal(manager.size, 0);
});

test("expires idle sessions and closes their stores", async () => {
  let now = 1_000;
  const closed = [];
  const manager = new BrowserSessionManager({
    now: () => now,
    idleTtlMs: 100,
    createStore: () => fakeStore([], closed),
  });
  const { token } = await manager.create("/workspace/alpha");

  now = 1_101;
  assert.equal(await manager.snapshot(token), null);
  assert.equal(closed.length, 1);
});

test("evicts the least recently accessed session at the cap", async () => {
  let now = 1;
  const manager = deterministicManager({ now: () => now, maxSessions: 2 });
  const first = await manager.create("/workspace/one");
  now = 2;
  const second = await manager.create("/workspace/two");
  now = 3;
  await manager.touch(first.token);
  now = 4;
  await manager.create("/workspace/three");

  assert.ok(await manager.touch(first.token));
  assert.equal(await manager.touch(second.token), null);
  await manager.close();
});

test("refreshes and returns a snapshot without exposing its store", async () => {
  const calls = [];
  const store = {
    async bind() {},
    async refresh() {
      calls.push("refresh");
    },
    snapshot() {
      return { status: "synced", tree: { nodeCount: 1 } };
    },
    async close() {},
  };
  const manager = new BrowserSessionManager({ createStore: () => store });
  const { token } = await manager.create("/workspace/alpha");

  assert.deepEqual(await manager.snapshot(token), {
    status: "synced",
    tree: { nodeCount: 1 },
    source: ".handoff/context-map.md",
  });
  assert.deepEqual(calls, ["refresh"]);
  await manager.close();
});

test("closes every live store and clears its sessions", async () => {
  const closed = [];
  const manager = new BrowserSessionManager({
    createStore: () => fakeStore([], closed),
  });
  await manager.create("/workspace/one");
  await manager.create("/workspace/two");

  await manager.close();

  assert.equal(manager.size, 0);
  assert.equal(closed.length, 2);
});
