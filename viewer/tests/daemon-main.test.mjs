import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthCheck, readState, SCHEMA_VERSION, DAEMON_VERSION } from "../runtime/daemon-state.mjs";
import { startDaemon } from "../runtime/daemon-main.mjs";
import { SessionManager } from "../runtime/session-manager.mjs";

const assets = {
  html: "<!doctype html><main>viewer</main>",
  app: "globalThis.viewer=true",
  model: "export const model=true",
  styles: "body{color:black}",
};

const accessibleDirectoryFs = {
  async realpath(path) {
    return path;
  },
  async stat() {
    return { isDirectory: () => true };
  },
};

function fakeStore() {
  return {
    async bind() {},
    async refresh() {},
    snapshot() {
      return { status: "synced", version: "v1", tree: null, nodeCount: 0 };
    },
    async close() {},
  };
}

function fakeProcess(pid = 9999) {
  const emitter = new EventEmitter();
  emitter.pid = pid;
  return emitter;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "daemon-main-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await predicate();
}

function emptySessionManager() {
  return new SessionManager({ fsApi: accessibleDirectoryFs, createStore: () => fakeStore() });
}

test("startDaemon publishes a valid, healthy state record", async () => {
  await withTempDir(async (runtimeDir) => {
    const proc = fakeProcess(4242);
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager: emptySessionManager(),
      controlToken: "secret-token",
      idleCheckMs: 60_000,
      processObject: proc,
    });
    try {
      const state = await readState(runtimeDir);
      assert.equal(state.pid, 4242);
      assert.equal(state.port, daemon.port);
      assert.equal(state.controlToken, "secret-token");
      assert.equal(state.schemaVersion, SCHEMA_VERSION);
      assert.equal(state.daemonVersion, DAEMON_VERSION);
      assert.equal(await healthCheck(state), true);
    } finally {
      await daemon.close();
    }
  });
});

test("close removes the state and lock files and is idempotent", async () => {
  await withTempDir(async (runtimeDir) => {
    const { acquireStartupLock } = await import("../runtime/daemon-state.mjs");
    await acquireStartupLock(runtimeDir, { now: () => 1, pid: 1 });
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager: emptySessionManager(),
      idleCheckMs: 60_000,
      processObject: fakeProcess(),
    });
    assert.ok(await readState(runtimeDir));
    await daemon.close();
    assert.equal(await readState(runtimeDir), null);
    const { readLock } = await import("../runtime/daemon-state.mjs");
    assert.equal(await readLock(runtimeDir), null);
    await daemon.close(); // idempotent, no throw
  });
});

test("auto-shuts-down when no sessions remain after the idle interval", async () => {
  await withTempDir(async (runtimeDir) => {
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager: emptySessionManager(),
      idleCheckMs: 30,
      processObject: fakeProcess(),
    });
    assert.ok(await readState(runtimeDir));
    const removed = await waitFor(async () => (await readState(runtimeDir)) === null);
    assert.equal(removed, true);
    await daemon.close();
  });
});

test("stays alive while a session exists, then shuts down after it expires", async () => {
  await withTempDir(async (runtimeDir) => {
    let now = 1_000;
    const sessionManager = new SessionManager({
      fsApi: accessibleDirectoryFs,
      createStore: () => fakeStore(),
      now: () => now,
    });
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager,
      idleCheckMs: 30,
      processObject: fakeProcess(),
    });
    try {
      await sessionManager.create("/workspace/alpha", { idleMinutes: 1 });
      // Give the idle check a chance to fire; it must NOT close while a session exists.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.ok(await readState(runtimeDir), "daemon must stay alive while a session exists");
      // Expire the session by advancing the clock. The daemon's OWN idle tick must
      // prune the expired session and shut down (no manual prune() call here).
      now += 61 * 60 * 1000;
      const removed = await waitFor(async () => (await readState(runtimeDir)) === null);
      assert.equal(removed, true);
    } finally {
      await daemon.close();
    }
  });
});

test("SIGTERM triggers a graceful close", async () => {
  await withTempDir(async (runtimeDir) => {
    const proc = fakeProcess();
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager: emptySessionManager(),
      idleCheckMs: 60_000,
      processObject: proc,
    });
    assert.ok(await readState(runtimeDir));
    proc.emit("SIGTERM");
    const removed = await waitFor(async () => (await readState(runtimeDir)) === null);
    assert.equal(removed, true);
    await daemon.close();
  });
});

test("closes the server and session manager if state publishing fails during startup", async () => {
  await withTempDir(async (dir) => {
    const badRuntimeDir = join(dir, "does-not-exist", "nested");
    const sessionManager = emptySessionManager();
    let sessionManagerClosed = false;
    const originalClose = sessionManager.close.bind(sessionManager);
    sessionManager.close = async () => {
      sessionManagerClosed = true;
      return originalClose();
    };
    await assert.rejects(() =>
      startDaemon({
        runtimeDir: badRuntimeDir,
        loadAssets: async () => assets,
        sessionManager,
        idleCheckMs: 60_000,
        processObject: fakeProcess(),
      }));
    assert.equal(sessionManagerClosed, true, "startup cleanup must close the session manager");
  });
});

test("generates a crypto-random control token when none is supplied", async () => {
  await withTempDir(async (runtimeDir) => {
    const daemon = await startDaemon({
      runtimeDir,
      loadAssets: async () => assets,
      sessionManager: emptySessionManager(),
      idleCheckMs: 60_000,
      processObject: fakeProcess(),
    });
    try {
      assert.match(daemon.controlToken, /^[A-Za-z0-9_-]{43}$/);
      const state = await readState(runtimeDir);
      assert.equal(state.controlToken, daemon.controlToken);
    } finally {
      await daemon.close();
    }
  });
});
