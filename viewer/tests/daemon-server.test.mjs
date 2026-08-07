import assert from "node:assert/strict";
import test from "node:test";

import { DaemonServer } from "../runtime/daemon-server.mjs";

const CONTROL_TOKEN = "test-control-token-abcdef";

const assets = {
  html: "<!doctype html><main>viewer</main>",
  app: "globalThis.viewer=true",
  model: "export const model=true",
  styles: "body{color:black}",
};

function fakeSessionManager(options = {}) {
  const sessions = new Map();
  if (options.fixedToken) {
    sessions.set(options.fixedToken, { workspaceRoot: "/workspace/fixed", idleMinutes: 30 });
  }
  let counter = 0;
  return {
    async create(workspaceRoot, { idleMinutes = 30 } = {}) {
      if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) {
        throw new Error("VIEW_INVALID_IDLE_MINUTES");
      }
      const token = options.fixedToken ?? `token-${counter++}-${"x".repeat(28)}`;
      sessions.set(token, { workspaceRoot, idleMinutes });
      return { token, sessionId: `sess-${counter}`, source: ".handoff/context-map.md", idleMinutes };
    },
    async touch(token) {
      return sessions.has(token) ? { token } : null;
    },
    async snapshot(token) {
      if (!sessions.has(token)) return null;
      return { status: "synced", version: "v1", tree: null, nodeCount: 0, source: ".handoff/context-map.md" };
    },
    async remove(token) {
      sessions.delete(token);
    },
    async close() {
      this.closed = true;
    },
    closed: false,
  };
}

async function startServer(options = {}) {
  const sessionManager = options.sessionManager ?? fakeSessionManager();
  const server = new DaemonServer({
    sessionManager,
    assets,
    controlToken: CONTROL_TOKEN,
    onShutdownRequest: options.onShutdownRequest,
    pid: options.pid ?? 4242,
  });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  return { server, sessionManager, base, port };
}

function authHeaders(token = CONTROL_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

test("rejects control requests without a valid token", async () => {
  const { server, base } = await startServer();
  try {
    const noAuth = await fetch(`${base}/control/health`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/control/health`, { headers: authHeaders("wrong") });
    assert.equal(badAuth.status, 401);
  } finally {
    await server.close();
  }
});

test("GET /control/health returns identity for an authenticated caller", async () => {
  const { server, base } = await startServer({ pid: 4242 });
  try {
    const response = await fetch(`${base}/control/health`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.pid, 4242);
    assert.equal(body.schemaVersion, 1);
    assert.equal(typeof body.daemonVersion, "string");
  } finally {
    await server.close();
  }
});

test("POST /control/session creates a session and returns a viewer URL", async () => {
  const { server, base, port } = await startServer();
  try {
    const response = await fetch(`${base}/control/session`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ workspaceRoot: "/workspace/alpha", idleMinutes: 45 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/session/[A-Za-z0-9_-]{22,}/$`));
    assert.equal(body.source, ".handoff/context-map.md");
    assert.equal(body.idleMinutes, 45);
    assert.equal(typeof body.sessionId, "string");
  } finally {
    await server.close();
  }
});

test("POST /control/session rejects a relative workspace root", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/control/session`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ workspaceRoot: "../alpha" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "VIEW_PROJECT_INACCESSIBLE");
  } finally {
    await server.close();
  }
});

test("POST /control/session rejects invalid idle minutes", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/control/session`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ workspaceRoot: "/workspace/alpha", idleMinutes: 9999 }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "VIEW_INVALID_IDLE_MINUTES");
  } finally {
    await server.close();
  }
});

test("POST /control/session rejects malformed JSON", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/control/session`, {
      method: "POST",
      headers: authHeaders(),
      body: "{ not json",
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("POST /control/shutdown invokes the shutdown callback", async () => {
  let shutdownCalled = 0;
  const { server, base } = await startServer({ onShutdownRequest: async () => { shutdownCalled += 1; } });
  try {
    const response = await fetch(`${base}/control/shutdown`, { method: "POST", headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "shutting_down");
    assert.equal(shutdownCalled, 1);
  } finally {
    await server.close();
  }
});

test("control routes reject unsupported methods with 405", async () => {
  const { server, base } = await startServer();
  try {
    const postHealth = await fetch(`${base}/control/health`, { method: "POST", headers: authHeaders() });
    assert.equal(postHealth.status, 405);
    assert.equal(postHealth.headers.get("allow"), "GET");
    const getSession = await fetch(`${base}/control/session`, { method: "GET", headers: authHeaders() });
    assert.equal(getSession.status, 405);
  } finally {
    await server.close();
  }
});

test("serves viewer assets and snapshot for a valid session token", async () => {
  const sessionManager = fakeSessionManager({ fixedToken: "a".repeat(32) });
  const { server, base } = await startServer({ sessionManager });
  try {
    const token = "a".repeat(32);
    const page = await fetch(`${base}/session/${token}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /viewer/);
    assert.equal(page.headers.get("content-security-policy") !== null, true);

    const api = await fetch(`${base}/session/${token}/api/context-map`);
    assert.equal(api.status, 200);
    const snapshot = await api.json();
    assert.equal(snapshot.status, "synced");
  } finally {
    await server.close();
  }
});

test("returns 404 for an unknown or expired viewer token", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/session/${"z".repeat(32)}/api/context-map`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("rejects encoded path traversal before routing", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/session/%2e%2e/secret`, { redirect: "manual" });
    assert.ok([400, 404].includes(response.status));
  } finally {
    await server.close();
  }
});

test("viewer routes reject non-GET methods with 405", async () => {
  const sessionManager = fakeSessionManager({ fixedToken: "b".repeat(32) });
  const { server, base } = await startServer({ sessionManager });
  try {
    const response = await fetch(`${base}/session/${"b".repeat(32)}/`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  } finally {
    await server.close();
  }
});

test("close stops the listener and closes the session manager", async () => {
  const sessionManager = fakeSessionManager();
  const { server, base } = await startServer({ sessionManager });
  await server.close();
  assert.equal(sessionManager.closed, true);
  await assert.rejects(() => fetch(`${base}/control/health`, { headers: authHeaders() }));
});

test("requires a control token at construction", () => {
  assert.throws(() => new DaemonServer({ sessionManager: fakeSessionManager(), assets, controlToken: "" }), /control token/i);
});

// ── v3 lazy node-detail endpoint ─────────────────────────────────────────────

test("GET /session/<token>/node/<id> returns the node detail with no-store headers", async () => {
  const fixedToken = `detail-${"d".repeat(28)}`;
  const sessionManager = fakeSessionManager({ fixedToken });
  sessionManager.nodeDetail = async (token, id) => {
    if (token !== fixedToken) return null;
    if (id !== "task1") return null;
    return {
      id: "task1",
      section: "tasks",
      label: "Wire lazy node details",
      summary: "Lazy detail summary.",
      body: "Lazy detail **body**.",
      version: "v123",
      diagnostic: null,
    };
  };
  const { server, base } = await startServer({ sessionManager });
  try {
    const response = await fetch(`${base}/session/${fixedToken}/node/task1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const detail = await response.json();
    assert.equal(detail.id, "task1");
    assert.equal(detail.section, "tasks");
    assert.equal(detail.label, "Wire lazy node details");
    assert.equal(detail.summary, "Lazy detail summary.");
    assert.equal(detail.body, "Lazy detail **body**.");
    assert.equal(detail.version, "v123");
  } finally {
    await server.close();
  }
});

test("node endpoint: malformed IDs are 400, unknown IDs are 404, traversal stays 404", async () => {
  const fixedToken = `detail-${"e".repeat(28)}`;
  const sessionManager = fakeSessionManager({ fixedToken });
  sessionManager.nodeDetail = async () => null;
  const { server, base } = await startServer({ sessionManager });
  try {
    for (const bad of ["foo", "TASK1", "task0", "task1x", "1task"]) {
      const response = await fetch(`${base}/session/${fixedToken}/node/${bad}`);
      assert.equal(response.status, 400, `'${bad}' must be 400`);
      assert.equal((await response.json()).error, "ID_INVALID");
    }
    const unknown = await fetch(`${base}/session/${fixedToken}/node/task99`);
    assert.equal(unknown.status, 404);

    // IDs outside the route grammar (hyphens, encoded separators) never reach
    // the node handler and stay safe 404s. (Literal "%2e%2e" is normalized by
    // fetch itself before it ever reaches the server, so it is not tested
    // here; the server-side ENCODED_PATH_CONTROL_PATTERN covers raw requests.)
    for (const hostile of ["task-1", "..%2ftask1", "task1%2f.."]) {
      const response = await fetch(`${base}/session/${fixedToken}/node/${hostile}`);
      assert.equal(response.status, 404, `'${hostile}' must be 404`);
    }

    const foreign = await fetch(`${base}/session/${"z".repeat(32)}/node/task1`);
    assert.equal(foreign.status, 404, "another session's token must not resolve nodes");
  } finally {
    await server.close();
  }
});

test("node endpoint: a v2 layout reports MIGRATION_REQUIRED", async () => {
  const fixedToken = `detail-${"f".repeat(28)}`;
  const sessionManager = fakeSessionManager({ fixedToken });
  sessionManager.nodeDetail = async () => ({ error: "MIGRATION_REQUIRED" });
  const { server, base } = await startServer({ sessionManager });
  try {
    const response = await fetch(`${base}/session/${fixedToken}/node/task1`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "MIGRATION_REQUIRED");
  } finally {
    await server.close();
  }
});
