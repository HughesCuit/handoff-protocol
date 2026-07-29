import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESOURCE_URI,
  createContextMapServer,
} from "../server/server.mjs";

const pluginRoot = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, pluginRoot), "utf8"));
}

test("plugin manifest launches the bundled MCP server", async () => {
  const manifest = await readJson(".codex-plugin/plugin.json");
  const mcp = await readJson(".mcp.json");

  assert.equal(manifest.name, "context-map-viewer");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(mcp.mcpServers["context-map-viewer"], {
    command: "node",
    args: ["./dist/server.bundle.mjs"],
    cwd: ".",
  });
});

test("build emits a self-contained MCP Apps widget", async () => {
  const html = await readFile(new URL("dist/widget.html", pluginRoot), "utf8");

  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /tools\/call/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test("registers a render tool and a headless refresh tool with no path input", () => {
  const store = {
    bind: async () => {},
    refresh: async () => {},
    snapshot: () => ({ status: "synced", version: "v1", tree: null, nodeCount: 0 }),
  };
  const server = createContextMapServer({
    store,
    rootProvider: async () => [{ uri: "file:///workspace", name: "workspace" }],
    widgetHtml: "<main>viewer</main>",
  });
  const open = server._registeredTools.open_context_map;
  const refresh = server._registeredTools.get_context_map;

  assert.equal(open._meta.ui.resourceUri, RESOURCE_URI);
  assert.equal(open._meta["openai/outputTemplate"], RESOURCE_URI);
  assert.equal(refresh._meta?.ui, undefined);
  assert.deepEqual(Object.keys(open.inputSchema.shape), []);
  assert.deepEqual(Object.keys(refresh.inputSchema.shape), []);
  for (const tool of [open, refresh]) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test("tools bind the single MCP root and return structured snapshots", async () => {
  const calls = [];
  const store = {
    bind: async (uri) => calls.push(["bind", uri]),
    refresh: async () => calls.push(["refresh"]),
    snapshot: () => ({
      status: "synced",
      version: "v1",
      tree: { root: { id: "context-map", text: "Context Map", children: [] }, nodeCount: 0 },
      nodeCount: 0,
    }),
  };
  const server = createContextMapServer({
    store,
    rootProvider: async () => [{ uri: "file:///workspace", name: "workspace" }],
    widgetHtml: "<main>viewer</main>",
  });

  const result = await server._registeredTools.open_context_map.handler({});

  assert.deepEqual(calls, [["bind", "file:///workspace"]]);
  assert.equal(result.structuredContent.status, "synced");
  assert.equal(result.structuredContent.source, ".handoff/context-map.md");
  assert.match(result.content[0].text, /Context Map/);
});

test("zero or ambiguous MCP roots return actionable read-only errors", async () => {
  const store = {
    bind: async () => assert.fail("must not bind without one root"),
    refresh: async () => {},
    snapshot: () => ({}),
  };
  for (const roots of [
    [],
    [{ uri: "file:///one" }, { uri: "file:///two" }],
  ]) {
    const server = createContextMapServer({
      store,
      rootProvider: async () => roots,
      widgetHtml: "<main>viewer</main>",
    });
    const result = await server._registeredTools.open_context_map.handler({});
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "access_denied");
    assert.match(result.content[0].text, /workspace root/i);
  }
});

test("registers an MCP Apps HTML resource", async () => {
  const server = createContextMapServer({
    store: {},
    rootProvider: async () => [],
    widgetHtml: "<main>viewer</main>",
  });
  const resource = server._registeredResources[RESOURCE_URI];
  const result = await resource.readCallback(new URL(RESOURCE_URI));

  assert.equal(result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(result.contents[0].text, "<main>viewer</main>");
});
