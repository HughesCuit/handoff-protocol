import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ContextMapStore } from "../runtime/context-store.mjs";

const FIRST = "# Context Map\n\n## Tasks\n\n- [ ] First\n";
const SECOND = "# Context Map\n\n## Tasks\n\n- [x] Second\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "viewer-store-"));
  await mkdir(join(root, ".handoff"));
  const file = join(root, ".handoff", "context-map.md");
  return { root, file, uri: pathToFileURL(root).href };
}

async function waitFor(predicate, timeout = 8_000) {
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
      const { resolveContextMap } = await import("../runtime/context-source.mjs");
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

// ── v3 layout: lazy node details ─────────────────────────────────────────────

const V3_MAP = `# Context Map

<!-- handoff-protocol:v3.0.0 — Semantic directory. -->

## Current Goal

- \`goal1\` Ship the v3 viewer

## Tasks

- [ ] \`task1\` **high** Wire lazy node details
  - [x] \`task2\` Define the index

## Risks

- \`risk1\` **high** Orphaned content
`;

const V3_CONTENT = {
  "current-goal.md": "# Current Goal\n\n## goal1\n\nShip the v3 viewer with lazy details.\n\nThe full goal body.\n",
  "current-status.md": "# Current Status\n",
  "tasks.md": "# Tasks\n\n## task1\n\nLazy detail summary.\n\nLazy detail body with **markdown**.\n\n## task2\n\nIndex summary.\n",
  "decisions.md": "# Decisions\n",
  "open-questions.md": "# Open Questions\n",
  "risks.md": "# Risks\n\n## risk1\n\nRisk summary.\n",
  "knowledge-notes.md": "# Knowledge and Notes\n",
  "excluded.md": "# Excluded\n",
};

async function v3Fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "viewer-store-v3-"));
  const contentDir = join(root, ".handoff", "content");
  await mkdir(contentDir, { recursive: true });
  await writeFile(join(root, ".handoff", "context-map.md"), overrides.map ?? V3_MAP);
  for (const [name, body] of Object.entries(V3_CONTENT)) {
    await writeFile(join(contentDir, name), overrides[name] ?? body);
  }
  return { root, uri: pathToFileURL(root).href, contentDir };
}

test("v3: the tree uses stable protocol IDs and node details load lazily", async (t) => {
  const item = await v3Fixture();
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const snapshot = store.snapshot();
  assert.equal(snapshot.status, "synced");
  assert.equal(snapshot.layout, "v3");
  const sections = snapshot.tree.root.children;
  const tasks = sections.find((node) => node.section === "tasks");
  assert.equal(tasks.children[0].id, "task1");
  assert.equal(tasks.children[0].text, "Wire lazy node details");
  assert.equal(tasks.children[0].children[0].id, "task2");
  assert.equal(tasks.children[0].children[0].taskState, "done");
  const goals = sections.find((node) => node.section === "goal");
  assert.equal(goals.children[0].id, "goal1");

  const detail = await store.nodeDetail("task1");
  assert.equal(detail.id, "task1");
  assert.equal(detail.section, "tasks");
  assert.equal(detail.label, "Wire lazy node details");
  assert.equal(detail.summary, "Lazy detail summary.");
  assert.equal(detail.body, "Lazy detail body with **markdown**.");
  assert.equal(typeof detail.version, "string");
  assert.equal(detail.diagnostic, null);

  const missing = await store.nodeDetail("task99");
  assert.equal(missing, null, "unknown IDs resolve to null (404)");
});

test("v3: content is parsed once per version and file changes invalidate the cache", async (t) => {
  const item = await v3Fixture();
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const first = await store.nodeDetail("task1");
  assert.equal(first.body, "Lazy detail body with **markdown**.");

  // An unrelated refresh reuses the parsed cache (same version).
  await store.refresh();
  const again = await store.nodeDetail("task1");
  assert.equal(again.version, first.version, "unchanged content must keep its version");

  // A content edit invalidates the index: new version, new body.
  await writeFile(
    join(item.contentDir, "tasks.md"),
    "# Tasks\n\n## task1\n\nLazy detail summary.\n\nEdited body.\n\n## task2\n\nIndex summary.\n",
  );
  let updated = null;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    updated = await store.nodeDetail("task1");
    if (updated?.body === "Edited body.") break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(updated?.body, "Edited body.");
  assert.notEqual(updated.version, first.version, "edited content must produce a new version");
});

test("v3: a missing body stays visible as a directory-only node with a diagnostic", async (t) => {
  const item = await v3Fixture({ "risks.md": "# Risks\n" });
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const detail = await store.nodeDetail("risk1");
  assert.equal(detail.id, "risk1");
  assert.equal(detail.label, "Orphaned content");
  assert.equal(detail.summary, "");
  assert.equal(detail.body, "");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
});

test("v3: a misplaced body is never guessed; the node reports CONTENT_MISSING", async (t) => {
  // risk1's body lives in the tasks file (its Map section is risks).
  const item = await v3Fixture({
    "tasks.md": "# Tasks\n\n## task1\n\nLazy detail summary.\n\nBody.\n\n## task2\n\nIndex summary.\n\n## risk1\n\nMisplaced risk body.\n",
    "risks.md": "# Risks\n",
  });
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const detail = await store.nodeDetail("risk1");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "", "a misplaced body must not be guessed");
});

test("v2: node details report MIGRATION_REQUIRED instead of reading root files", async (t) => {
  const item = await fixture();
  await writeFile(item.file, FIRST);
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  assert.equal(store.snapshot().status, "synced", "v2 maps still render the tree");
  assert.equal(store.snapshot().layout, "v2");
  const detail = await store.nodeDetail("task1");
  assert.equal(detail.error, "MIGRATION_REQUIRED");
});

test("v3: content-only edits update the snapshot content version while the map version stays", async (t) => {
  const item = await v3Fixture();
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const initial = store.snapshot();
  assert.equal(initial.status, "synced");
  assert.ok(initial.contentVersion, "v3 snapshots carry a content version");

  // Only a content body changes; the map stays byte-identical. The refresh is
  // driven explicitly (as each Viewer poll does server-side), so the assertion
  // measures the unchanged-map path, not OS event delivery.
  await writeFile(
    join(item.contentDir, "tasks.md"),
    "# Tasks\n\n## task1\n\nLazy detail summary.\n\nEdited body.\n\n## task2\n\nIndex summary.\n",
  );

  await store.refresh();
  const changed = store.snapshot();
  assert.notEqual(changed.contentVersion, initial.contentVersion, "content-only edits must bump the content version");
  assert.equal(changed.version, initial.version, "the map version must not change");
  assert.equal(changed.status, "synced");
  const detail = await store.nodeDetail("task1");
  assert.equal(detail.body, "Edited body.");
});

test("v3: the content directory is watched explicitly and its events refresh content", async (t) => {
  const item = await v3Fixture();
  const root = await realpath(item.root);
  const watchers = new Map();
  const store = new ContextMapStore({
    debounceMs: 10,
    watch: (path, callback) => {
      const record = { path, callback, closed: false };
      watchers.set(path, record);
      return {
        close: () => {
          record.closed = true;
        },
        on() {},
      };
    },
  });
  t.after(() => store.close());

  await store.bind(item.uri);
  const initial = store.snapshot();
  assert.equal(initial.status, "synced");

  const handoffDir = join(root, ".handoff");
  const contentDir = join(handoffDir, "content");
  assert.ok(watchers.has(handoffDir), "the handoff dir must be watched");
  assert.ok(watchers.has(contentDir), "the content dir must be watched explicitly");

  // Simulate a platform where only the content-dir watcher observes the edit.
  await writeFile(
    join(contentDir, "tasks.md"),
    "# Tasks\n\n## task1\n\nLazy detail summary.\n\nEdited body.\n\n## task2\n\nIndex summary.\n",
  );
  watchers.get(contentDir).callback("change", "tasks.md");
  await waitFor(() => store.snapshot().contentVersion !== initial.contentVersion);
  assert.equal(store.snapshot().version, initial.version, "the map version must not change");

  await store.close();
  assert.equal(watchers.get(handoffDir).closed, true);
  assert.equal(watchers.get(contentDir).closed, true, "close must dispose the content watcher");
});

test("v3: content-only edits refresh snapshot diagnostics without a map change", async (t) => {
  const item = await v3Fixture();
  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());

  await store.bind(item.uri);
  const initial = store.snapshot();
  assert.deepEqual(initial.contentDiagnostics, []);

  // An orphan body entry appears — a content-only change. Refresh is driven
  // explicitly (as each Viewer poll does server-side).
  await writeFile(
    join(item.contentDir, "tasks.md"),
    `${V3_CONTENT["tasks.md"]}\n## note99\n\nOrphan body.\n`,
  );

  await store.refresh();
  const changed = store.snapshot();
  assert.ok(changed.contentDiagnostics.length > 0, "content-only edits must refresh diagnostics");
  assert.equal(changed.version, initial.version, "the map version must not change");
  assert.ok(
    changed.contentDiagnostics.includes("CONTENT_ORPHAN: note99"),
    `expected CONTENT_ORPHAN: note99 in ${JSON.stringify(changed.contentDiagnostics)}`,
  );
});

test("v3: a content file symlinked outside the workspace is never served", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "viewer-store-outside-"));
  const secret = join(outside, "secret.md");
  await writeFile(secret, "# Tasks\n\n## task1\n\nSECRET EXTERNAL BYTES\n");
  const item = await v3Fixture();
  await rm(join(item.contentDir, "tasks.md"));
  await symlink(secret, join(item.contentDir, "tasks.md"));

  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());
  await store.bind(item.uri);

  const detail = await store.nodeDetail("task1");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "");
  assert.ok(
    !JSON.stringify(detail).includes("SECRET EXTERNAL BYTES"),
    "an escaping content symlink must not reach the node-detail surface",
  );
});

test("v3: a content directory redirected outside the workspace never leaks bytes", async (t) => {
  const item = await v3Fixture();
  const outside = await mkdtemp(join(tmpdir(), "viewer-store-outside-dir-"));
  await writeFile(join(outside, "tasks.md"), "# Tasks\n\n## task1\n\nOUTSIDE DIR BYTES\n");
  await rename(item.contentDir, `${item.contentDir}-original`);
  await symlink(outside, item.contentDir);

  const store = new ContextMapStore({ debounceMs: 30 });
  t.after(() => store.close());
  await store.bind(item.uri);

  const detail = await store.nodeDetail("task1");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "");
  assert.ok(
    !JSON.stringify(detail).includes("OUTSIDE DIR BYTES"),
    "a redirected content directory must not leak external bytes",
  );
});
