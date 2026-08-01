import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { LoopbackViewerServer } from "../server/loopback-viewer-server.mjs";

function fakeSessionManager() {
  let sequence = 0;
  const tokens = new Set();
  return {
    expectedSnapshot: { status: "synced", nodeCount: 1, source: ".handoff/context-map.md" },
    closed: false,
    createCalls: 0,
    closeCalls: 0,
    async create() {
      this.createCalls += 1;
      const token = `session_token_${String(++sequence).padStart(10, "0")}`;
      tokens.add(token);
      return { token, sessionId: "session-id", source: ".handoff/context-map.md" };
    },
    async touch(token) {
      return tokens.has(token) ? { token } : null;
    },
    async snapshot(token) {
      return tokens.has(token) ? this.expectedSnapshot : null;
    },
    async close() {
      this.closed = true;
      this.closeCalls += 1;
      tokens.clear();
    },
    expire(token) {
      tokens.delete(token);
    },
  };
}

function assertSecurityHeaders(headers) {
  const get = typeof headers.get === "function"
    ? (name) => headers.get(name)
    : (name) => headers[name];
  assert.equal(get("cache-control"), "no-store");
  assert.equal(
    get("content-security-policy"),
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
  assert.equal(get("referrer-policy"), "no-referrer");
  assert.equal(get("x-content-type-options"), "nosniff");
}

function requestRaw(url, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      method,
      path,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
}

function assets() {
  return {
    html: "<!doctype html><main>viewer</main>",
    app: "globalThis.viewer=true",
    model: "export const model=true",
    styles: "body{color:black}",
  };
}

async function startedViewer() {
  const manager = fakeSessionManager();
  const viewer = new LoopbackViewerServer({ sessionManager: manager, assets: assets() });
  const session = await viewer.createSession("/workspace/alpha");
  return { viewer, session, manager };
}

test("binds to loopback and serves only token-scoped viewer content", async () => {
  const manager = fakeSessionManager();
  const viewer = new LoopbackViewerServer({
    sessionManager: manager,
    assets: assets(),
  });
  const session = await viewer.createSession("/workspace/alpha");
  const address = viewer.address();
  assert.equal(address.host, "127.0.0.1");
  assert.match(session.viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/session\/[^/]+\/$/);

  const page = await fetch(session.viewerUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /viewer/);
  assertSecurityHeaders(page.headers);
  await viewer.close();
});

test("serves only allowlisted token-scoped assets", async (t) => {
  const { viewer, session } = await startedViewer();
  t.after(() => viewer.close());

  const assetsToCheck = [
    ["app.mjs", "globalThis.viewer=true", "text/javascript; charset=utf-8"],
    ["model.mjs", "export const model=true", "text/javascript; charset=utf-8"],
    ["styles.css", "body{color:black}", "text/css; charset=utf-8"],
  ];
  for (const [path, content, type] of assetsToCheck) {
    const response = await fetch(new URL(path, session.viewerUrl));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
    assert.equal(response.headers.get("content-type"), type);
  }
});

test("rejects invalid tokens, paths, queries, and non-GET methods without disclosure", async (t) => {
  const { viewer, session } = await startedViewer();
  t.after(() => viewer.close());
  for (const suffix of ["../secret", "%2e%2e/secret", "api/context-map?file=x"]) {
    const response = await fetch(new URL(suffix, session.viewerUrl), { redirect: "manual" });
    assert.ok([400, 404].includes(response.status));
  }
  const unknown = new URL(session.viewerUrl);
  unknown.pathname = "/session/unknown_token_000000000000/";
  const missing = await fetch(unknown);
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing.headers);

  const post = await fetch(session.viewerUrl, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("rejects raw percent-encoded traversal before URL normalization", async (t) => {
  const { viewer, session } = await startedViewer();
  t.after(() => viewer.close());
  const url = new URL(session.viewerUrl);
  const token = url.pathname.split("/")[2];

  for (const path of [
    `/session/${token}/%2e/app.mjs`,
    `/session/${token}/%2fapp.mjs`,
    `/session/${token}/%5capp.mjs`,
  ]) {
    const response = await requestRaw(url, path);
    assert.equal(response.statusCode, 404);
    assertSecurityHeaders(response.headers);
  }
});

test("serves safe snapshots and reports sessions that expire during refresh", async (t) => {
  const { viewer, session, manager } = await startedViewer();
  t.after(() => viewer.close());
  const endpoint = new URL("api/context-map", session.viewerUrl);
  const response = await fetch(endpoint);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), manager.expectedSnapshot);

  manager.snapshot = async (token) => {
    manager.expire(token);
    return null;
  };
  assert.equal((await fetch(endpoint)).status, 404);
});

test("closes the listener and session stores", async () => {
  const { viewer, session, manager } = await startedViewer();
  await viewer.close();
  assert.equal(manager.closed, true);
  await assert.rejects(() => fetch(session.viewerUrl));
});

test("makes shutdown terminal while coordinating start and session creation", async (t) => {
  const manager = fakeSessionManager();
  const viewer = new LoopbackViewerServer({ sessionManager: manager, assets: assets() });
  t.after(async () => {
    if (!viewer.httpServer?.listening) return;
    await new Promise((resolve) => viewer.httpServer.close(resolve));
  });

  const starting = viewer.start();
  const closing = viewer.close();
  await assert.rejects(() => viewer.createSession("/workspace/after-close"), /closed/i);
  await Promise.all([starting, closing]);
  assert.equal(viewer.address(), null);
  assert.equal(manager.closed, true);
  assert.equal(manager.createCalls, 0);
  await viewer.close();
  assert.equal(manager.closeCalls, 1);
  await assert.rejects(() => viewer.start(), /closed/i);
  await assert.rejects(() => viewer.createSession("/workspace/after-close"), /closed/i);
});

test("closes a session created while shutdown is waiting", async (t) => {
  const manager = fakeSessionManager();
  const originalCreate = manager.create.bind(manager);
  let enterCreate;
  let releaseCreate;
  const entered = new Promise((resolve) => {
    enterCreate = resolve;
  });
  const release = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  manager.create = async (workspaceRoot) => {
    enterCreate();
    await release;
    return originalCreate(workspaceRoot);
  };
  const viewer = new LoopbackViewerServer({ sessionManager: manager, assets: assets() });
  t.after(async () => {
    if (!viewer.httpServer?.listening) return;
    await new Promise((resolve) => viewer.httpServer.close(resolve));
  });

  const creating = viewer.createSession("/workspace/in-flight");
  await entered;
  const closing = viewer.close();
  releaseCreate();

  await assert.rejects(creating, /closed/i);
  await closing;
  assert.equal(manager.createCalls, 1);
  assert.equal(manager.closed, true);
  assert.equal(viewer.address(), null);
});
