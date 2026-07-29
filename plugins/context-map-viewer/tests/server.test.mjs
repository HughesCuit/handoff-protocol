import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  RESOURCE_URI,
  createContextMapServer,
  selectActiveRoot,
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

test("skill prefers the side browser and retains inline fallback", async () => {
  const skill = await readFile(
    new URL("../skills/context-map-viewer/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skill, /create_context_map_browser_session/);
  assert.match(skill, /in-app browser/i);
  assert.match(skill, /open_context_map/);
  assert.match(skill, /fallback/i);
  assert.match(skill, /absolute.*cwd/i);
  assert.match(
    skill,
    /create_context_map_browser_session[\s\S]*?exact absolute `cwd`[\s\S]*?Open the returned `viewerUrl` with the Codex in-app browser tool/i,
  );
  assert.match(
    skill,
    /Do not[\s\S]*?transform, reconstruct, persist, or reuse `viewerUrl` in another task/i,
  );
  assert.match(
    skill,
    /If session creation or in-app browser navigation is unavailable[\s\S]*?fallback: call `open_context_map` with the same `workspaceRoot`/i,
  );
  assert.match(skill, /Do not repeatedly reopen either view/i);
  assert.match(skill, /Treat the viewer as read-only/i);
});

test("build emits a self-contained MCP Apps widget", async () => {
  const [widgetHtml, standaloneHtml, standaloneApp] = await Promise.all([
    readFile(new URL("dist/widget.html", pluginRoot), "utf8"),
    readFile(new URL("dist/standalone/index.html", pluginRoot), "utf8"),
    readFile(new URL("dist/standalone/app.mjs", pluginRoot), "utf8"),
  ]);

  assert.match(widgetHtml, /ui\/notifications\/tool-result/);
  assert.match(widgetHtml, /tools\/call/);
  assert.match(widgetHtml, /arguments:\{bindingId:/);
  assert.doesNotMatch(widgetHtml, /<script[^>]+src=/);
  assert.doesNotMatch(widgetHtml, /<link[^>]+href=/);
  assert.match(standaloneHtml, /content="http/);
  assert.match(standaloneHtml, /src="\.\/app\.mjs"/);
  assert.match(standaloneApp, /api\/context-map/);
  assert.doesNotMatch(standaloneApp, /tools\/call/);
});

test("registers explicit workspace binding and opaque refresh inputs", () => {
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
  assert.deepEqual(Object.keys(open.inputSchema.shape), ["workspaceRoot"]);
  assert.deepEqual(Object.keys(refresh.inputSchema.shape), ["bindingId"]);
  for (const tool of [open, refresh]) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
});

test("registers a read-only browser session tool with an explicit cwd", async () => {
  const calls = [];
  const browserViewer = {
    createSession: async (root) => {
      calls.push(root);
      return {
        viewerUrl: "http://127.0.0.1:4312/session/token/",
        sessionId: "session-1",
        source: ".handoff/context-map.md",
      };
    },
    close: async () => {},
  };
  const server = createContextMapServer({ browserViewer, widgetHtml: "<main/>" });
  const tool = server._registeredTools.create_context_map_browser_session;
  const result = await tool.handler({ workspaceRoot: "/workspace/project" });

  assert.deepEqual(calls, ["/workspace/project"]);
  assert.equal(result.structuredContent.status, "ready");
  assert.equal(result.structuredContent.fallback, "open_context_map");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta?.ui, undefined);
});

test("browser session reports safe structured errors for invalid roots and unavailable viewers", async () => {
  const unavailable = createContextMapServer({
    browserViewer: {
      createSession: async () => {
        throw new Error("/private/workspace must remain private");
      },
      close: async () => {},
    },
    widgetHtml: "<main/>",
  });
  const tool = unavailable._registeredTools.create_context_map_browser_session;

  for (const [workspaceRoot, diagnostic] of [
    ["relative/project", "WORKSPACE_ROOT_REQUIRED"],
    ["/workspace/project", "BROWSER_SESSION_UNAVAILABLE"],
  ]) {
    const result = await tool.handler({ workspaceRoot });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "unavailable");
    assert.equal(result.structuredContent.diagnostic, diagnostic);
    assert.equal(result.structuredContent.fallback, "open_context_map");
    assert.doesNotMatch(result.content[0].text, /\/private\/workspace/i);
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /\/private\/workspace/i);
  }
});

test("open binds an explicit Codex cwd when MCP roots are unavailable", async () => {
  const calls = [];
  const store = {
    bind: async (uri) => calls.push(["bind", uri]),
    refresh: async () => calls.push(["refresh"]),
    snapshot: () => ({
      status: "synced",
      version: "v1",
      tree: { root: { id: "context-map", text: "Context Map", children: [] } },
      nodeCount: 0,
      bindingId: "binding-1",
    }),
  };
  const server = createContextMapServer({
    store,
    rootProvider: async () => [],
    widgetHtml: "<main>viewer</main>",
  });

  const result = await server._registeredTools.open_context_map.handler({
    workspaceRoot: "/workspace/project",
  });

  assert.deepEqual(calls, [["bind", "file:///workspace/project"]]);
  assert.equal(result.structuredContent.bindingId, "binding-1");
});

test("refresh accepts only the currently bound opaque id", async () => {
  const calls = [];
  const store = {
    bind: async () => {},
    refresh: async () => calls.push(["refresh"]),
    snapshot: () => ({
      status: "synced",
      version: "v1",
      tree: { root: { id: "context-map", text: "Context Map", children: [] } },
      nodeCount: 0,
      bindingId: "binding-1",
    }),
  };
  const server = createContextMapServer({
    store,
    rootProvider: async () => [],
    widgetHtml: "<main>viewer</main>",
  });

  const current = await server._registeredTools.get_context_map.handler({
    bindingId: "binding-1",
  });
  const stale = await server._registeredTools.get_context_map.handler({
    bindingId: "binding-old",
  });

  assert.deepEqual(calls, [["refresh"]]);
  assert.equal(current.structuredContent.status, "synced");
  assert.equal(stale.isError, true);
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
    assert.equal(result.structuredContent.bindingId, "no-workspace");
    assert.match(result.content[0].text, /workspace root/i);
  }
});

test("multiple roots select the unique workspace containing a Context Map", async () => {
  const project = await mkdtemp(join(tmpdir(), "viewer-project-"));
  const visualization = await mkdtemp(join(tmpdir(), "viewer-visualization-"));
  await mkdir(join(project, ".handoff"));
  await writeFile(
    join(project, ".handoff", "context-map.md"),
    "# Context Map\n\n## Tasks\n\n- [ ] Render map\n",
  );
  const projectRoot = { uri: pathToFileURL(project).href, name: "project" };
  const visualizationRoot = {
    uri: pathToFileURL(visualization).href,
    name: "visualization",
  };

  assert.deepEqual(
    await selectActiveRoot([projectRoot, visualizationRoot]),
    projectRoot,
  );
});

test("multiple roots stay ambiguous when more than one contains a Context Map", async () => {
  const roots = [];
  for (const name of ["first", "second"]) {
    const root = await mkdtemp(join(tmpdir(), `viewer-${name}-`));
    await mkdir(join(root, ".handoff"));
    await writeFile(
      join(root, ".handoff", "context-map.md"),
      "# Context Map\n\n## Tasks\n\n- [ ] Item\n",
    );
    roots.push({ uri: pathToFileURL(root).href, name });
  }

  assert.equal(await selectActiveRoot(roots), null);
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
