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

import { SessionManager } from "../runtime/session-manager.mjs";

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
  return new SessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(24, byte++),
    createStore: () => fakeStore(),
    ...options,
  });
}

test("creates an opaque session permanently bound to one workspace", async () => {
  const calls = [];
  const stores = [];
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(24, 7),
    createStore: () => {
      const store = fakeStore(calls);
      stores.push(store);
      return store;
  },
  });

  const created = await manager.create("/workspace/alpha", { idleMinutes: 30 });

  assert.match(created.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(created.source, ".handoff/context-map.md");
  assert.equal(created.idleMinutes, 30);
  assert.deepEqual(calls, [["bind", "file:///workspace/alpha"]]);
  assert.equal((await manager.touch(created.token)).store, stores[0]);
  assert.equal((await manager.touch(created.token)).workspaceRoot, undefined);
  await manager.close();
});

test("rejects a relative workspace before retaining a session", async () => {
  const manager = new SessionManager();

  await assert.rejects(() => manager.create("../alpha"), /absolute workspace/i);
  assert.equal(manager.size, 0);
});

test("rejects a nonexistent workspace before retaining a real store", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "viewer-missing-root-"));
  t.after(() => rm(parent, { recursive: true }));
  const manager = new SessionManager();

  await assert.rejects(() => manager.create(join(parent, "does-not-exist"), { idleMinutes: 30 }));
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
  const manager = new SessionManager();

  await assert.rejects(() => manager.create(workspace, { idleMinutes: 30 }));
  assert.equal(manager.size, 0);
  await manager.close();
});

test("creates no store when canonical root validation fails", async () => {
  const closed = [];
  const manager = new SessionManager({
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

  await assert.rejects(() => manager.create("/workspace/inaccessible", { idleMinutes: 30 }));
  assert.equal(manager.size, 0);
  assert.equal(closed.length, 0);
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
  const manager = new SessionManager();
  t.after(async () => {
    await manager.close();
    await rm(parent, { recursive: true });
  });

  const created = await manager.create(workspaceLink, { idleMinutes: 30 });
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

test("each session expires by its own idle deadline", async () => {
  let now = 1_000;
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    now: () => now,
    createStore: () => fakeStore(),
  });
  const short = await manager.create("/workspace/alpha", { idleMinutes: 1 });
  const long = await manager.create("/workspace/beta", { idleMinutes: 60 });

  now += 30 * 60 * 1000; // 30 minutes - past short's 1-min deadline, within long's 60-min deadline
  assert.equal(await manager.snapshot(short.token), null);
  assert.ok(await manager.snapshot(long.token));
  await manager.close();
});

test("reuses one project store for two sessions on the same root", async () => {
  const stores = [];
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    createStore: () => {
      const s = fakeStore();
      stores.push(s);
      return s;
    },
  });
  await manager.create("/workspace/alpha", { idleMinutes: 30 });
  await manager.create("/workspace/alpha", { idleMinutes: 30 });

  assert.equal(stores.length, 1);
  await manager.close();
});

test("closes project store when its last session is removed", async () => {
  const closed = [];
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    createStore: () => fakeStore([], closed),
  });
  const a = await manager.create("/workspace/alpha", { idleMinutes: 30 });
  const b = await manager.create("/workspace/alpha", { idleMinutes: 30 });

  await manager.remove(a.token);
  assert.equal(closed.length, 0);
  await manager.remove(b.token);
  assert.equal(closed.length, 1);
  await manager.close();
});

test("hasSessions is false after all sessions expire", async () => {
  let now = 1;
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    now: () => now,
    createStore: () => fakeStore(),
  });
  await manager.create("/workspace/alpha", { idleMinutes: 1 });
  assert.equal(manager.hasSessions, true);

  now += 61 * 60 * 1000;
  await manager.prune();
  assert.equal(manager.hasSessions, false);
});

test("evicts the least recently accessed session at the cap", async () => {
  let now = 1;
  const manager = deterministicManager({ now: () => now, maxSessions: 2 });
  const first = await manager.create("/workspace/one", { idleMinutes: 30 });
  now = 2;
  const second = await manager.create("/workspace/two", { idleMinutes: 30 });
  now = 3;
  await manager.touch(first.token);
  now = 4;
  await manager.create("/workspace/three", { idleMinutes: 30 });

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
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    createStore: () => store,
  });
  const { token } = await manager.create("/workspace/alpha", { idleMinutes: 30 });

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
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    createStore: () => fakeStore([], closed),
  });
  await manager.create("/workspace/one", { idleMinutes: 30 });
  await manager.create("/workspace/two", { idleMinutes: 30 });

  await manager.close();

  assert.equal(manager.size, 0);
  assert.equal(closed.length, 2);
});

test("serializes concurrent creation at the hard session cap", async () => {
  const closed = [];
  const manager = deterministicManager({
    maxSessions: 99,
    createStore: () => fakeStore([], closed),
  });

  await Promise.all(
    Array.from({ length: 9 }, (_, index) => manager.create(`/workspace/${index}`, { idleMinutes: 30 })),
  );

  assert.equal(manager.size, 8);
  assert.equal(closed.length, 1);
  await manager.close();
});

test("rejects invalid idleMinutes values", async () => {
  const manager = new SessionManager({ fsApi: accessibleDirectoryFs });

  await assert.rejects(() => manager.create("/workspace/alpha", { idleMinutes: 0 }), /VIEW_INVALID_IDLE_MINUTES/);
  await assert.rejects(() => manager.create("/workspace/alpha", { idleMinutes: 1441 }), /VIEW_INVALID_IDLE_MINUTES/);
  await assert.rejects(() => manager.create("/workspace/alpha", { idleMinutes: 1.5 }), /VIEW_INVALID_IDLE_MINUTES/);
  await assert.rejects(() => manager.create("/workspace/alpha", { idleMinutes: "30" }), /VIEW_INVALID_IDLE_MINUTES/);
  assert.equal(manager.size, 0);
});

test("defaults idleMinutes to 30 when not specified", async () => {
  const manager = new SessionManager({ fsApi: accessibleDirectoryFs, createStore: () => fakeStore() });
  const created = await manager.create("/workspace/alpha");
  assert.equal(created.idleMinutes, 30);
  await manager.close();
});

test("rejects random-byte providers that return fewer than 16 bytes", async () => {
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(15),
    createStore: () => {
      assert.fail("a store must not be created for an invalid token source");
    },
  });

  await assert.rejects(() => manager.create("/workspace/alpha", { idleMinutes: 30 }), /at least 16 bytes/i);
  assert.equal(manager.size, 0);
});

test("rejects repeated token collisions after a bounded number of attempts", async () => {
  const manager = new SessionManager({
    fsApi: accessibleDirectoryFs,
    randomBytes: () => Buffer.alloc(24, 7),
    createStore: () => fakeStore(),
  });
  await manager.create("/workspace/one", { idleMinutes: 30 });

  await assert.rejects(() => manager.create("/workspace/two", { idleMinutes: 30 }), /unique session token/i);
  assert.equal(manager.size, 1);
  await manager.close();
});

// ── v3 lazy node details through a real session ──────────────────────────────

test("nodeDetail resolves through the session's own workspace only", async () => {
  const { mkdtemp: makeTmp } = await import("node:fs/promises");
  const { writeFile: write, mkdir: mk } = await import("node:fs/promises");
  const { tmpdir: tmp } = await import("node:os");
  const { join: pathJoin } = await import("node:path");

  const seed = async (marker) => {
    const root = await makeTmp(pathJoin(tmp(), "viewer-session-v3-"));
    await mk(pathJoin(root, ".handoff", "content"), { recursive: true });
    await write(
      pathJoin(root, ".handoff", "context-map.md"),
      `# Context Map\n\n<!-- handoff-protocol:v3.0.0 — Semantic directory. -->\n\n## Tasks\n\n- [ ] \`task1\` ${marker}\n`,
    );
    for (const name of ["current-goal.md", "current-status.md", "decisions.md", "open-questions.md", "risks.md", "knowledge-notes.md", "excluded.md"]) {
      await write(pathJoin(root, ".handoff", "content", name), `# x\n`);
    }
    await write(pathJoin(root, ".handoff", "content", "tasks.md"), `# Tasks\n\n## task1\n\n${marker} summary.\n`);
    return root;
  };

  const workspaceA = await seed("Alpha task");
  const workspaceB = await seed("Beta task");
  const manager = new SessionManager();
  try {
    const a = await manager.create(workspaceA, { idleMinutes: 30 });
    const b = await manager.create(workspaceB, { idleMinutes: 30 });

    const detailA = await manager.nodeDetail(a.token, "task1");
    assert.equal(detailA.label, "Alpha task");
    assert.equal(detailA.summary, "Alpha task summary.");

    const detailB = await manager.nodeDetail(b.token, "task1");
    assert.equal(detailB.label, "Beta task");

    // A session can never read another workspace: task2 exists nowhere in A,
    // and A's view of task1 is strictly its own.
    assert.equal(await manager.nodeDetail(a.token, "task2"), null);
    assert.notEqual(detailA.summary, detailB.summary);

    assert.equal(await manager.nodeDetail("no-such-token", "task1"), null);
  } finally {
    await manager.close();
  }
});
