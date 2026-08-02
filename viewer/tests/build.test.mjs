import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

let built = false;
async function ensureBuilt() {
  if (built) return;
  await execFileAsync(process.execPath, [resolve(root, "scripts/build.mjs")]);
  built = true;
}

test("build emits the four standalone assets", async () => {
  await ensureBuilt();
  for (const name of ["index.html", "app.mjs", "model.mjs", "styles.css"]) {
    const info = await stat(resolve(dist, name));
    assert.ok(info.isFile(), `${name} must exist in dist/`);
    assert.ok(info.size > 0, `${name} must not be empty`);
  }
});

test("built index.html is the standalone shell with the http transport marker", async () => {
  await ensureBuilt();
  const html = await readFile(resolve(dist, "index.html"), "utf8");
  assert.match(html, /content="http"/);
  assert.match(html, /src="\.\/app\.mjs"/);
  assert.match(html, /href="\.\/styles\.css"/);
});

test("built app.mjs uses the HTTP snapshot endpoint and no MCP bridge", async () => {
  await ensureBuilt();
  const app = await readFile(resolve(dist, "app.mjs"), "utf8");
  assert.match(app, /api\/context-map/);
  assert.doesNotMatch(app, /tools\/call/);
  assert.doesNotMatch(app, /createMcpTransport/);
});

test("built app.mjs keeps model.mjs as an external same-origin import", async () => {
  await ensureBuilt();
  const app = await readFile(resolve(dist, "app.mjs"), "utf8");
  assert.match(app, /from"\.\/model\.mjs"|from "\.\/model\.mjs"|from'\.\/model\.mjs'/);
});
