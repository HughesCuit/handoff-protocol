import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ContextMapStore } from "../server/context-store.mjs";

const FIRST = "# Context Map\n\n## Tasks\n\n- [ ] First\n";
const SECOND = "# Context Map\n\n## Tasks\n\n- [x] Second\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "viewer-store-"));
  await mkdir(join(root, ".handoff"));
  const file = join(root, ".handoff", "context-map.md");
  return { root, file, uri: pathToFileURL(root).href };
}

async function waitFor(predicate, timeout = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for Context Map refresh");
}

test("watches modify, atomic rename, and delete while retaining the last valid map", async (t) => {
  const item = await fixture();
  await writeFile(item.file, FIRST);
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const initial = store.snapshot();
  assert.equal(initial.status, "synced");
  assert.equal(initial.tree.root.children[0].children[0].text, "First");

  await writeFile(item.file, SECOND);
  await waitFor(() => store.snapshot().tree?.root.children[0].children[0].text === "Second");
  const changed = store.snapshot();
  assert.notEqual(changed.version, initial.version);

  const replacement = join(item.root, ".handoff", "replacement.md");
  await writeFile(replacement, FIRST);
  await rename(replacement, item.file);
  await waitFor(() => store.snapshot().tree?.root.children[0].children[0].text === "First");

  await writeFile(item.file, "# invalid");
  await waitFor(() => store.snapshot().status === "invalid");
  assert.equal(store.snapshot().tree.root.children[0].children[0].text, "First");
});

test("reports missing then observes creation without rebinding", async (t) => {
  const item = await fixture();
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  assert.equal(store.snapshot().status, "missing");

  await writeFile(item.file, FIRST);
  await waitFor(() => store.snapshot().status === "synced");
  assert.equal(store.snapshot().tree.root.children[0].children[0].text, "First");
});

test("rebinding disposes the old watcher and unchanged content keeps its version", async (t) => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(first.file, FIRST);
  await writeFile(second.file, SECOND);
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(first.uri);
  const version = store.snapshot().version;
  await store.refresh();
  assert.equal(store.snapshot().version, version);

  await store.bind(second.uri);
  assert.equal(store.snapshot().tree.root.children[0].children[0].text, "Second");
  await writeFile(first.file, "# Context Map\n\n## Tasks\n\n- [ ] Stale\n");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(store.snapshot().tree.root.children[0].children[0].text, "Second");
});

test("switching workspaces clears the previous tree before a missing source is reported", async (t) => {
  const first = await fixture();
  const second = await fixture();
  await writeFile(first.file, FIRST);
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(first.uri);
  assert.equal(store.snapshot().tree.root.children[0].children[0].text, "First");

  await store.bind(second.uri);
  assert.equal(store.snapshot().status, "missing");
  assert.equal(store.snapshot().tree, null);
  assert.equal(store.snapshot().version, null);
  assert.equal(store.snapshot().nodeCount, 0);
});

test("polling fallback preserves content status and does not rebind the same root", async (t) => {
  const item = await fixture();
  let resolveCount = 0;
  let watchCount = 0;
  const store = new ContextMapStore({
    pollIntervalMs: 10_000,
    resolveSource: async (...args) => {
      resolveCount += 1;
      const { resolveContextMap } = await import("../server/context-source.mjs");
      return resolveContextMap(...args);
    },
    watch: () => {
      watchCount += 1;
      throw new Error("watch unavailable");
    },
  });
  t.after(() => store.close());

  await store.bind(item.uri);
  assert.equal(store.snapshot().status, "missing");
  assert.equal(store.snapshot().watchMode, "polling");
  assert.equal(store.snapshot().watchDiagnostic, "WATCHER_UNAVAILABLE");

  await store.bind(item.uri);
  assert.equal(watchCount, 1);
  assert.equal(resolveCount, 3);
  assert.equal(store.snapshot().status, "missing");
});

test("an inaccessible replacement root returns a cleared bound snapshot", async (t) => {
  const item = await fixture();
  await writeFile(item.file, FIRST);
  const store = new ContextMapStore();
  t.after(() => store.close());
  await store.bind(item.uri);

  await store.bind("file:///definitely-not-a-context-map-workspace");

  assert.equal(store.snapshot().status, "access_denied");
  assert.equal(store.snapshot().tree, null);
  assert.equal(store.snapshot().diagnostic, "ACCESS_DENIED");
  assert.notEqual(store.snapshot().bindingId, null);
});
