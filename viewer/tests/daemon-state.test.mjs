import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireStartupLock,
  createStateRecord,
  DAEMON_VERSION,
  getRuntimeDir,
  healthCheck,
  isStaleLock,
  isValidState,
  readLock,
  readState,
  releaseStartupLock,
  removeState,
  SCHEMA_VERSION,
  writeState,
} from "../runtime/daemon-state.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "daemon-state-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("getRuntimeDir creates a 0o700 directory under tmpdir", async () => {
  await withTempDir(async (base) => {
    const dir = await getRuntimeDir({ tmpdir: base, uid: 501, platform: "darwin" });
    assert.equal(dir, join(base, "handoff-501"));
    const info = await stat(dir);
    assert.ok(info.isDirectory());
    assert.equal(info.mode & 0o777, 0o700);
  });
});

test("getRuntimeDir is idempotent for an existing valid directory", async () => {
  await withTempDir(async (base) => {
    const first = await getRuntimeDir({ tmpdir: base, uid: 501, platform: "darwin" });
    const second = await getRuntimeDir({ tmpdir: base, uid: 501, platform: "darwin" });
    assert.equal(first, second);
  });
});

test("getRuntimeDir uses XDG_RUNTIME_DIR on linux when provided", async () => {
  await withTempDir(async (base) => {
    const xdg = join(base, "xdg");
    const dir = await getRuntimeDir({ tmpdir: base, uid: 501, platform: "linux", xdgRuntimeDir: xdg });
    assert.equal(dir, join(xdg, "handoff"));
  });
});

test("getRuntimeDir rejects a symlinked state directory", async () => {
  await withTempDir(async (base) => {
    const real = join(base, "real");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(real);
    const fakeTmp = join(base, "tmp");
    await mkdir(fakeTmp);
    await symlink(real, join(fakeTmp, "handoff-501"), "dir");
    await assert.rejects(
      () => getRuntimeDir({ tmpdir: fakeTmp, uid: 501, platform: "darwin" }),
      /VIEW_STATE_UNSAFE/,
    );
  });
});

test("getRuntimeDir rejects a directory owned by another user", async () => {
  const fsApi = {
    async lstat() {
      return { isSymbolicLink: () => false, isDirectory: () => true, uid: 999, mode: 0o700 };
    },
    async stat() {
      return { isDirectory: () => true, uid: 999, mode: 0o700 };
    },
    async mkdir() {},
    async chmod() {},
  };
  await assert.rejects(
    () => getRuntimeDir({ fsApi, tmpdir: "/tmp", uid: 501, platform: "darwin" }),
    /VIEW_STATE_UNSAFE/,
  );
});

test("getRuntimeDir rejects a directory with group/other permissions", async () => {
  const fsApi = {
    async lstat() {
      return { isSymbolicLink: () => false, isDirectory: () => true, uid: 501, mode: 0o755 };
    },
    async stat() {
      return { isDirectory: () => true, uid: 501, mode: 0o755 };
    },
    async mkdir() {},
    async chmod() {},
  };
  await assert.rejects(
    () => getRuntimeDir({ fsApi, tmpdir: "/tmp", uid: 501, platform: "darwin" }),
    /VIEW_STATE_UNSAFE/,
  );
});

test("writeState then readState roundtrips a valid record", async () => {
  await withTempDir(async (dir) => {
    const record = createStateRecord({ pid: 1234, port: 5432, controlToken: "secret-token", now: () => 1_000 });
    await writeState(dir, record);
    const read = await readState(dir);
    assert.deepEqual(read, record);
    assert.equal(read.schemaVersion, SCHEMA_VERSION);
    assert.equal(read.daemonVersion, DAEMON_VERSION);
  });
});

test("writeState writes the state file with 0o600 permissions", async () => {
  await withTempDir(async (dir) => {
    await writeState(dir, createStateRecord({ pid: 1, port: 2, controlToken: "t" }));
    const info = await stat(join(dir, "daemon.json"));
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("readState returns null when the state file is missing", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readState(dir), null);
  });
});

test("readState returns null for malformed JSON", async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "daemon.json"), "{ not json");
    assert.equal(await readState(dir), null);
  });
});

test("readState returns null for a record failing validation", async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "daemon.json"), JSON.stringify({ schemaVersion: 999, pid: 1 }));
    assert.equal(await readState(dir), null);
  });
});

test("removeState removes the file and ignores a missing file", async () => {
  await withTempDir(async (dir) => {
    await writeState(dir, createStateRecord({ pid: 1, port: 2, controlToken: "t" }));
    await removeState(dir);
    assert.equal(await readState(dir), null);
    await removeState(dir); // no throw on missing
  });
});

test("acquireStartupLock is exclusive: first wins, second loses", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await acquireStartupLock(dir, { now: () => 1, pid: 100 }), true);
    assert.equal(await acquireStartupLock(dir, { now: () => 2, pid: 200 }), false);
  });
});

test("acquireStartupLock removes a partial lock when writing fails, allowing reacquire", async () => {
  await withTempDir(async (dir) => {
    const { open } = await import("node:fs/promises");
    const failingFs = {
      open,
      rm: (await import("node:fs/promises")).rm,
    };
    const realOpen = failingFs.open;
    failingFs.open = async (...args) => {
      const handle = await realOpen(...args);
      return {
        writeFile: async () => {
          throw new Error("ENOSPC");
        },
        close: () => handle.close(),
      };
    };
    await assert.rejects(
      () => acquireStartupLock(dir, { fsApi: failingFs, now: () => 1, pid: 1 }),
      /ENOSPC/,
    );
    // The partial lock must not block a subsequent acquisition.
    assert.equal(await acquireStartupLock(dir, { now: () => 2, pid: 2 }), true);
    await releaseStartupLock(dir);
  });
});

test("readLock reports the lock owner pid and age", async () => {
  await withTempDir(async (dir) => {
    await acquireStartupLock(dir, { now: () => 1_000, pid: 777 });
    const lock = await readLock(dir, { now: () => 6_000 });
    assert.equal(lock.pid, 777);
    assert.equal(lock.ageMs, 5_000);
  });
});

test("readLock returns null when no lock exists", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readLock(dir), null);
  });
});

test("releaseStartupLock removes the lock so it can be reacquired", async () => {
  await withTempDir(async (dir) => {
    await acquireStartupLock(dir, { now: () => 1, pid: 1 });
    await releaseStartupLock(dir);
    assert.equal(await readLock(dir), null);
    assert.equal(await acquireStartupLock(dir, { now: () => 2, pid: 2 }), true);
    await releaseStartupLock(dir); // no throw on missing
  });
});

test("isStaleLock is true only when old and daemon unhealthy", async () => {
  const old = { ageMs: 60_000 };
  const fresh = { ageMs: 1_000 };
  assert.equal(isStaleLock(old, { maxLockAgeMs: 30_000, daemonHealthy: false }), true);
  assert.equal(isStaleLock(old, { maxLockAgeMs: 30_000, daemonHealthy: true }), false);
  assert.equal(isStaleLock(fresh, { maxLockAgeMs: 30_000, daemonHealthy: false }), false);
  assert.equal(isStaleLock(null, { maxLockAgeMs: 30_000, daemonHealthy: false }), false);
});

test("isValidState accepts a complete record and rejects partial ones", () => {
  const good = createStateRecord({ pid: 1, port: 2, controlToken: "t" });
  assert.equal(isValidState(good), true);
  assert.equal(isValidState({ ...good, controlToken: "" }), false);
  assert.equal(isValidState({ ...good, port: "x" }), false);
  assert.equal(isValidState(null), false);
  assert.equal(isValidState([]), false);
});

test("healthCheck returns true when the daemon confirms matching identity", async () => {
  const state = createStateRecord({ pid: 42, port: 9999, controlToken: "tok" });
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push([url, options]);
    return {
      ok: true,
      async json() {
        return { pid: 42, schemaVersion: SCHEMA_VERSION, daemonVersion: DAEMON_VERSION };
      },
    };
  };
  assert.equal(await healthCheck(state, { fetch: fakeFetch }), true);
  assert.equal(calls[0][0], "http://127.0.0.1:9999/control/health");
  assert.equal(calls[0][1].headers.Authorization, "Bearer tok");
});

test("healthCheck returns false on identity mismatch", async () => {
  const state = createStateRecord({ pid: 42, port: 9999, controlToken: "tok" });
  const fakeFetch = async () => ({
    ok: true,
    async json() {
      return { pid: 999, schemaVersion: SCHEMA_VERSION, daemonVersion: DAEMON_VERSION };
    },
  });
  assert.equal(await healthCheck(state, { fetch: fakeFetch }), false);
});

test("healthCheck returns false on non-ok response (e.g. 401)", async () => {
  const state = createStateRecord({ pid: 42, port: 9999, controlToken: "tok" });
  const fakeFetch = async () => ({ ok: false, status: 401, async json() { return {}; } });
  assert.equal(await healthCheck(state, { fetch: fakeFetch }), false);
});

test("healthCheck returns false on network error", async () => {
  const state = createStateRecord({ pid: 42, port: 9999, controlToken: "tok" });
  const fakeFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await healthCheck(state, { fetch: fakeFetch }), false);
});

test("healthCheck returns false for an invalid state record", async () => {
  assert.equal(await healthCheck({ pid: 1 }, { fetch: async () => ({ ok: true, async json() { return {}; } }) }), false);
});
