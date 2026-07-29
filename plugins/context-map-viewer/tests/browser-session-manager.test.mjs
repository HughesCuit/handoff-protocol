import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserSessionManager } from "../server/browser-session-manager.mjs";

const accessibleDirectoryFs = {
  async realpath(path) {
    return path;
  },
  async stat() {
    return { isDirectory: () => true };
  },
};

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
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(24, byte++),
    createStore: () => fakeStore(),
    ...options,
  });
}

test("creates an opaque session permanently bound to one workspace", async () => {
  const calls = [];
  const stores = [];
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
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

test("rejects a nonexistent workspace before retaining a real store", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "viewer-missing-root-"));
  t.after(() => rm(parent, { recursive: true }));
  const manager = new BrowserSessionManager();

  await assert.rejects(() => manager.create(join(parent, "does-not-exist")));
  assert.equal(manager.size, 0);
  await manager.close();
});

test("rejects an inaccessible workspace before retaining a real store", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "viewer-inaccessible-root-"));
  const workspace = join(parent, "workspace");
  await mkdir(workspace);
  t.after(async () => {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true });
  });
  await chmod(parent, 0);
  const manager = new BrowserSessionManager();

  await assert.rejects(() => manager.create(workspace));
  assert.equal(manager.size, 0);
  await manager.close();
});

test("closes the new store when canonical root validation fails", async () => {
  const closed = [];
  const manager = new BrowserSessionManager({
    fsApi: {
      async realpath() {
        const error = new Error("inaccessible");
        error.code = "EACCES";
        throw error;
      },
      async stat() {
        assert.fail("stat must not run after realpath fails");
      },
    },
    createStore: () => fakeStore([], closed),
  });

  await assert.rejects(() => manager.create("/workspace/inaccessible"));
  assert.equal(manager.size, 0);
  assert.equal(closed.length, 1);
});

test("keeps a real session on the original canonical workspace after a root symlink is retargeted", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "viewer-canonical-root-"));
  const original = join(parent, "original");
  const replacement = join(parent, "replacement");
  const workspaceLink = join(parent, "workspace");
  for (const [root, label] of [
    [original, "Original workspace"],
    [replacement, "Replacement workspace"],
  ]) {
    await mkdir(join(root, ".handoff"), { recursive: true });
    await writeFile(
      join(root, ".handoff", "context-map.md"),
      `# Context Map\n\n## Tasks\n\n- [ ] ${label}\n`,
    );
  }
  await symlink(original, workspaceLink, "dir");
  const manager = new BrowserSessionManager();
  t.after(async () => {
    await manager.close();
    await rm(parent, { recursive: true });
  });

  const created = await manager.create(workspaceLink);
  const beforeRetarget = await manager.snapshot(created.token);
  await rm(workspaceLink);
  await symlink(replacement, workspaceLink, "dir");
  const afterRetarget = await manager.snapshot(created.token);

  assert.match(JSON.stringify(beforeRetarget), /Original workspace/);
  assert.match(JSON.stringify(afterRetarget), /Original workspace/);
  assert.doesNotMatch(JSON.stringify(afterRetarget), /Replacement workspace/);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(original));
  assert.doesNotMatch(JSON.stringify(afterRetarget), new RegExp(original));
});

test("expires idle sessions and closes their stores", async () => {
  let now = 1_000;
  const closed = [];
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
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
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
    createStore: () => store,
  });
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
    fsApi: accessibleDirectoryFs,
    createStore: () => fakeStore([], closed),
  });
  await manager.create("/workspace/one");
  await manager.create("/workspace/two");

  await manager.close();

  assert.equal(manager.size, 0);
  assert.equal(closed.length, 2);
});

test("clamps session and idle limits to the hard maximums", async () => {
  let now = 0;
  const closed = [];
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
    now: () => now,
    maxSessions: 99,
    idleTtlMs: 99 * 60 * 1000,
    createStore: () => fakeStore([], closed),
  });
  const { token } = await manager.create("/workspace/alpha");

  assert.equal(manager.maxSessions, 8);
  assert.equal(manager.idleTtlMs, 30 * 60 * 1000);
  now = 30 * 60 * 1000;
  assert.equal(await manager.touch(token), null);
  assert.equal(closed.length, 1);
});

test("serializes concurrent creation at the hard session cap", async () => {
  const closed = [];
  const manager = deterministicManager({
    maxSessions: 99,
    createStore: () => fakeStore([], closed),
  });

  await Promise.all(
    Array.from({ length: 9 }, (_, index) => manager.create(`/workspace/${index}`)),
  );

  assert.equal(manager.size, 8);
  assert.equal(closed.length, 1);
  await manager.close();
});

test("keeps a healthy session when a replacement store fails to bind", async () => {
  const closed = [];
  const healthy = fakeStore([], closed);
  const failing = {
    ...fakeStore([], closed),
    async bind() {
      throw new Error("bind failed");
    },
  };
  let storeCount = 0;
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
    maxSessions: 1,
    createStore: () => (storeCount++ === 0 ? healthy : failing),
  });
  const first = await manager.create("/workspace/one");

  await assert.rejects(() => manager.create("/workspace/two"), /bind failed/);
  assert.ok(await manager.touch(first.token));
  assert.equal(manager.size, 1);
  assert.equal(closed.length, 1);
  await manager.close();
});

test("rejects random-byte providers that return fewer than 16 bytes", async () => {
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(15),
    createStore: () => {
      assert.fail("a store must not be created for an invalid token source");
    },
  });

  await assert.rejects(() => manager.create("/workspace/alpha"), /at least 16 bytes/i);
  assert.equal(manager.size, 0);
});

test("rejects repeated token collisions after a bounded number of attempts", async () => {
  const manager = new BrowserSessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(24, 7),
    createStore: () => fakeStore(),
  });
  await manager.create("/workspace/one");

  await assert.rejects(() => manager.create("/workspace/two"), /unique session token/i);
  assert.equal(manager.size, 1);
  await manager.close();
});
