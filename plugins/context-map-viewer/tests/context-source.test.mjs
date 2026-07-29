import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ContextSourceError,
  readContextMapSource,
  resolveContextMap,
} from "../server/context-source.mjs";
import { MAX_SOURCE_BYTES } from "../server/constants.mjs";

async function workspace(name = "viewer-测试 space-") {
  const root = await mkdtemp(join(tmpdir(), name));
  await mkdir(join(root, ".handoff"));
  return root;
}

test("resolves only the fixed Context Map path in a Unicode workspace", async () => {
  const root = await workspace();
  const file = join(root, ".handoff", "context-map.md");
  await writeFile(file, "# Context Map\n\n## Tasks\n\n- [ ] Ship\n");

  const source = await resolveContextMap(pathToFileURL(root).href);

  assert.equal(source.rootPath, await realpath(root));
  assert.equal(source.filePath, await realpath(file));
  assert.equal(await readFile(source.filePath, "utf8"), "# Context Map\n\n## Tasks\n\n- [ ] Ship\n");
});

test("rejects a Context Map symlink that escapes the workspace", async () => {
  const root = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "viewer-outside-"));
  const secret = join(outside, "secret.md");
  await writeFile(secret, "outside");
  await symlink(secret, join(root, ".handoff", "context-map.md"));

  await assert.rejects(
    resolveContextMap(pathToFileURL(root).href),
    (error) => error instanceof ContextSourceError && error.code === "ACCESS_DENIED",
  );
});

test("reports missing and oversized sources without returning source content", async () => {
  const root = await workspace();
  const missing = await resolveContextMap(pathToFileURL(root).href);
  await assert.rejects(
    readContextMapSource(missing),
    (error) => error instanceof ContextSourceError &&
      error.code === "MISSING" &&
      !error.message.includes(root),
  );

  const file = join(root, ".handoff", "context-map.md");
  await writeFile(file, Buffer.alloc(MAX_SOURCE_BYTES + 1, "x"));
  const source = await resolveContextMap(pathToFileURL(root).href);
  await assert.rejects(
    readContextMapSource(source),
    (error) => error instanceof ContextSourceError && error.code === "TOO_LARGE",
  );
});
