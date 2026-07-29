import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
