import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createMcpTransport,
  createPageLifecycle,
  createPageTransport,
} from "../web/transports.mjs";

function messageEvent(source, data) {
  const event = new Event("message");
  Object.defineProperties(event, {
    source: { value: source },
    data: { value: data },
  });
  return event;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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
    applySnapshot: (snapshot) => snapshots.push(snapshot),
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
  const transport = createHttpTransport({
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async (url, options) => {
      calls.push([String(url), options]);
      return new Response(JSON.stringify({ status: "synced", version: "v1" }));
    },
  });

  assert.deepEqual(await transport.initialSnapshot(), {
    status: "synced",
    version: "v1",
  });
  assert.equal(calls[0][0], "http://127.0.0.1:4312/session/token/api/context-map");
  assert.deepEqual(calls[0][1], {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
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

test("MCP transport unwraps tool results and accepts replies only from its parent", async () => {
  const windowObject = new EventTarget();
  const calls = [];
  const parentWindow = {
    postMessage(message, targetOrigin) {
      calls.push({ message, targetOrigin });
    },
  };
  const transport = createMcpTransport({ parentWindow, windowObject });
  const pending = transport.refresh("workspace-a");

  assert.deepEqual(calls, [{
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_context_map", arguments: { bindingId: "workspace-a" } },
    },
    targetOrigin: "*",
  }]);

  windowObject.dispatchEvent(messageEvent({}, {
      jsonrpc: "2.0",
      id: 1,
      result: { content: { structuredContent: { status: "wrong-source" } } },
  }));
  windowObject.dispatchEvent(messageEvent(parentWindow, {
      jsonrpc: "2.0",
      id: 1,
      result: { content: { structuredContent: { status: "synced", version: "v1" } } },
  }));

  assert.deepEqual(await pending, { status: "synced", version: "v1" });
  transport.dispose();
});

test("MCP transport forwards tool-result notifications and removes its listener on dispose", () => {
  const windowObject = new EventTarget();
  const parentWindow = { postMessage() {} };
  const snapshots = [];
  const transport = createMcpTransport({
    parentWindow,
    windowObject,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const notification = messageEvent(parentWindow, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { status: "synced", version: "v2" } },
  });

  windowObject.dispatchEvent(notification);
  transport.dispose();
  windowObject.dispatchEvent(notification);

  assert.deepEqual(snapshots, [{ status: "synced", version: "v2" }]);
});

test("page transport accepts only the explicit MCP and HTTP mode markers", () => {
  const httpDocument = {
    querySelector: () => ({ content: "http" }),
  };
  const mcpDocument = {
    querySelector: () => ({ content: "mcp" }),
  };
  const dependencies = {
    location: new URL("http://127.0.0.1:4312/session/token/"),
    fetch: async () => new Response("{}"),
    parentWindow: { postMessage() {} },
    windowObject: new EventTarget(),
  };

  assert.equal(typeof createPageTransport(httpDocument, dependencies).refresh, "function");
  assert.equal(typeof createPageTransport(mcpDocument, dependencies).refresh, "function");
  assert.throws(
    () => createPageTransport({ querySelector: () => ({ content: "https://example.com" }) }, dependencies),
    /Unsupported context-map viewer transport/,
  );
});

test("page lifecycle never applies an older refresh after a newer session expiry", async () => {
  const first = deferred();
  const second = deferred();
  let reads = 0;
  const harness = lifecycleHarness({
    refresh: () => (++reads === 1 ? first.promise : second.promise),
  });
  await harness.lifecycle.start();

  const olderRefresh = harness.lifecycle.refresh();
  const expiringRefresh = harness.lifecycle.refresh();
  second.reject(new Error("SESSION_EXPIRED"));
  await expiringRefresh;
  first.resolve({ status: "synced", version: "stale" });
  await olderRefresh;

  assert.deepEqual(harness.snapshots, [{ status: "initial" }]);
  assert.equal(harness.terminals.length, 1);
  assert.equal(harness.timers.size, 0);
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
