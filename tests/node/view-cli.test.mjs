import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, runView, ViewError } from "../../scripts/node/view.mjs";
import { DAEMON_VERSION, writeState, acquireStartupLock } from "../../viewer/runtime/daemon-state.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "view-cli-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeProject(dir, { mapContent = "# Context Map\n\n## Tasks\n\n- [ ] Task one\n" } = {}) {
  await mkdir(join(dir, ".handoff"), { recursive: true });
  await writeFile(join(dir, ".handoff", "context-map.md"), mapContent);
  return dir;
}

const CONTROL_TOKEN = "cli-test-token";

// A fake daemon world backed by a real temp dir for the state file.
function fakeDaemonWorld(runtimeDir) {
  const world = {
    healthy: false,
    state: null,
    spawned: 0,
    sessionBody: null,
    shutdowns: 0,
  };

  const fetch = async (url, options = {}) => {
    const auth = options.headers?.Authorization;
    if (url.endsWith("/control/health")) {
      if (!world.healthy || !world.state || auth !== `Bearer ${CONTROL_TOKEN}`) {
        return { ok: false, status: 401, async json() { return {}; } };
      }
      return { ok: true, async json() { return { pid: world.state.pid, schemaVersion: 1, daemonVersion: world.state.daemonVersion }; } };
    }
    if (url.endsWith("/control/session")) {
      world.sessionBody = JSON.parse(options.body);
      return { ok: true, async json() { return { url: `http://127.0.0.1:${world.state.port}/session/tok/`, sessionId: "s1", source: ".handoff/context-map.md", idleMinutes: world.sessionBody.idleMinutes } } };
    }
    if (url.endsWith("/control/shutdown")) {
      world.shutdowns += 1;
      world.healthy = false;
      world.state = null;
      return { ok: true, async json() { return {}; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const spawn = () => {
    world.spawned += 1;
    world.state = {
      schemaVersion: 1,
      daemonVersion: DAEMON_VERSION,
      pid: 4321,
      port: 65432,
      controlToken: CONTROL_TOKEN,
      startedAt: new Date().toISOString(),
    };
    world.healthy = true;
    void writeState(runtimeDir, world.state);
    return { unref() {} };
  };

  const sleep = async () => { await new Promise((resolve) => setImmediate(resolve)); };

  return { world, fetch, spawn, sleep };
}

function baseDeps(runtimeDir, projectDir, extra = {}) {
  const fake = fakeDaemonWorld(runtimeDir);
  return {
    fake,
    options: {
      argv: [],
      cwd: projectDir,
      runtimeDir,
      fetch: fake.fetch,
      spawn: fake.spawn,
      sleep: fake.sleep,
      now: () => 1_000,
      ...extra,
    },
  };
}

// ── parseArgs ───────────────────────────────────────────────────────────────

test("parseArgs defaults to 30 idle minutes and human output", () => {
  assert.deepEqual(parseArgs([]), { idleMinutes: 30, json: false });
});

test("parseArgs accepts boundary idle minutes", () => {
  assert.equal(parseArgs(["--idle-minutes", "1"]).idleMinutes, 1);
  assert.equal(parseArgs(["--idle-minutes", "1440"]).idleMinutes, 1440);
  assert.equal(parseArgs(["--idle-minutes=45"]).idleMinutes, 45);
});

test("parseArgs accepts --json", () => {
  assert.deepEqual(parseArgs(["--json", "--idle-minutes", "5"]), { idleMinutes: 5, json: true });
});

test("parseArgs rejects out-of-range and non-integer idle minutes", () => {
  for (const bad of ["0", "1441", "1.5", "abc", "-5"]) {
    assert.throws(() => parseArgs(["--idle-minutes", bad]), /VIEW_INVALID_IDLE_MINUTES/);
  }
  assert.throws(() => parseArgs(["--idle-minutes"]), /VIEW_INVALID_IDLE_MINUTES/);
});

test("parseArgs rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--nope"]), /VIEW_INVALID_IDLE_MINUTES/);
});

// ── validateProjectRoot (via runView) ───────────────────────────────────────

test("returns VIEW_CONTEXT_MISSING when no context map exists", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      // projectDir has no .handoff
      const { options } = baseDeps(runtimeDir, projectDir);
      const result = await runView(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VIEW_CONTEXT_MISSING");
    });
  });
});

test("returns VIEW_CONTEXT_INVALID for an unparseable context map", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir, { mapContent: "# Context Map\n\nnothing structured here\n" });
      const { options } = baseDeps(runtimeDir, projectDir);
      const result = await runView(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VIEW_CONTEXT_INVALID");
    });
  });
});

test("returns VIEW_CONTEXT_TOO_LARGE for an oversized map", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      const huge = "# Context Map\n\n## Tasks\n\n- [ ] " + "x".repeat(2 * 1024 * 1024) + "\n";
      await makeProject(projectDir, { mapContent: huge });
      const { options } = baseDeps(runtimeDir, projectDir);
      const result = await runView(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VIEW_CONTEXT_TOO_LARGE");
    });
  });
});

// ── daemon lifecycle ────────────────────────────────────────────────────────

test("starts a new daemon when none exists and returns a human URL", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir);
      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.spawned, 1);
      assert.match(result.output, /Context Map Viewer ready\./);
      assert.match(result.output, /URL: http:\/\/127\.0\.0\.1:65432\/session\/tok\//);
      assert.match(result.output, /Expires after: 30 minutes idle/);
      // The CLI sends the canonical (realpath) project root to the daemon.
      const { realpath } = await import("node:fs/promises");
      assert.equal(fake.world.sessionBody.workspaceRoot, await realpath(projectDir));
    });
  });
});

test("reuses a healthy existing daemon without spawning", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir);
      // Pre-publish a healthy state.
      await writeState(runtimeDir, {
        schemaVersion: 1, daemonVersion: DAEMON_VERSION, pid: 4321, port: 65432,
        controlToken: CONTROL_TOKEN, startedAt: new Date().toISOString(),
      });
      fake.world.state = { pid: 4321, port: 65432, daemonVersion: DAEMON_VERSION };
      fake.world.healthy = true;

      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.spawned, 0, "must not spawn when daemon is healthy");
    });
  });
});

test("removes a stale (dead) daemon record and starts a fresh one", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir);
      // Pre-publish a state, but the daemon is NOT healthy (world.healthy=false).
      await writeState(runtimeDir, {
        schemaVersion: 1, daemonVersion: DAEMON_VERSION, pid: 4321, port: 65432,
        controlToken: CONTROL_TOKEN, startedAt: new Date().toISOString(),
      });

      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.spawned, 1, "must restart after removing stale state");
    });
  });
});

test("replaces an incompatible daemon version via authenticated shutdown", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir);
      // Pre-publish an OLD-version healthy daemon.
      await writeState(runtimeDir, {
        schemaVersion: 1, daemonVersion: "9.9.9", pid: 4321, port: 65432,
        controlToken: CONTROL_TOKEN, startedAt: new Date().toISOString(),
      });
      fake.world.state = { pid: 4321, port: 65432, daemonVersion: "9.9.9" };
      fake.world.healthy = true;

      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.shutdowns, 1, "must request authenticated shutdown of old daemon");
      assert.equal(fake.world.spawned, 1, "must start the new-version daemon");
    });
  });
});

// ── output format ───────────────────────────────────────────────────────────

test("emits a JSON object with daemonReused for --json", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { options } = baseDeps(runtimeDir, projectDir, { argv: ["--json"] });
      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      const parsed = JSON.parse(result.output);
      assert.equal(parsed.status, "ready");
      assert.match(parsed.url, /^http:\/\/127\.0\.0\.1:65432\/session\/tok\/$/);
      assert.equal(parsed.source, ".handoff/context-map.md");
      assert.equal(parsed.idleMinutes, 30);
      assert.equal(parsed.daemonReused, false);
    });
  });
});

test("passes a custom idle-minutes through to the daemon session", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir, { argv: ["--idle-minutes", "120"] });
      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.sessionBody.idleMinutes, 120);
    });
  });
});

test("argument validation fails without touching the daemon", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      const { fake, options } = baseDeps(runtimeDir, projectDir, { argv: ["--idle-minutes", "0"] });
      const result = await runView(options);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VIEW_INVALID_IDLE_MINUTES");
      assert.equal(fake.world.spawned, 0, "must not spawn on invalid args");
    });
  });
});

test("ViewError carries a code", () => {
  const error = new ViewError("VIEW_CONTEXT_MISSING", "detail");
  assert.equal(error.code, "VIEW_CONTEXT_MISSING");
  assert.match(error.message, /detail/);
});

test("a held startup lock with no healthy daemon is recovered when stale", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      // Hold a stale lock (locked long ago) with no healthy daemon.
      await acquireStartupLock(runtimeDir, { now: () => 1_000, pid: 999 });
      const { fake, options } = baseDeps(runtimeDir, projectDir, { now: () => 1_000 + 60_000 });
      const result = await runView(options);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(fake.world.spawned, 1, "must recover the stale lock and start a daemon");
    });
  });
});

test("returns VIEW_DAEMON_VERSION_CONFLICT when the old daemon ignores shutdown", async () => {
  await withTempDir(async (runtimeDir) => {
    await withTempDir(async (projectDir) => {
      await makeProject(projectDir);
      await writeState(runtimeDir, {
        schemaVersion: 1, daemonVersion: "9.9.9", pid: 4321, port: 65432,
        controlToken: CONTROL_TOKEN, startedAt: new Date().toISOString(),
      });
      let now = 1_000;
      const fetch = async (url, options = {}) => {
        const auth = options.headers?.Authorization;
        if (url.endsWith("/control/health")) {
          return auth === `Bearer ${CONTROL_TOKEN}`
            ? { ok: true, async json() { return { pid: 4321, schemaVersion: 1, daemonVersion: "9.9.9" }; } }
            : { ok: false, status: 401, async json() { return {}; } };
        }
        if (url.endsWith("/control/shutdown")) {
          // Accepts the shutdown request but never actually exits (stays healthy).
          return { ok: true, async json() { return {}; } };
        }
        return { ok: false, status: 404, async json() { return {}; } };
      };
      let spawned = 0;
      const result = await runView({
        argv: [],
        cwd: projectDir,
        runtimeDir,
        fetch,
        spawn: () => { spawned += 1; return { unref() {} }; },
        now: () => now,
        sleep: async () => { now += 1_000; await new Promise((r) => setImmediate(r)); },
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "VIEW_DAEMON_VERSION_CONFLICT");
      assert.equal(spawned, 0, "must not spawn a replacement while the old daemon is still alive");
    });
  });
});

test("returns VIEW_STATE_UNSAFE when the runtime directory is unsafe", async () => {
  await withTempDir(async (projectDir) => {
    await makeProject(projectDir);
    const unsafeFs = {
      async lstat() { return { isSymbolicLink: () => true, isDirectory: () => false, uid: 501, mode: 0o700 }; },
      async stat() { return { isDirectory: () => true, uid: 501, mode: 0o700 }; },
      async mkdir() {},
      async chmod() {},
    };
    const { fake, options } = baseDeps("/tmp/unused-view-cli", projectDir, {
      fsApi: unsafeFs,
      tmpdir: "/tmp",
      uid: 501,
      platform: "darwin",
    });
    delete options.runtimeDir; // force getRuntimeDir to run and validate
    const result = await runView(options);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "VIEW_STATE_UNSAFE");
    assert.equal(fake.world.spawned, 0);
  });
});
