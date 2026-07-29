import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpTransport,
  createMcpTransport,
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
