import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContentIndex } from "../runtime/content-index.mjs";
import { CONTENT_DIR, CONTENT_FILES } from "../../scripts/content-files.mjs";

const V3_MAP = `# Context Map

<!-- handoff-protocol:v3.0.0 — Semantic directory. -->

## Tasks

- [ ] \`task1\` Wire lazy node details
`;

const CONTENT = {
  "current-goal.md": "# Current Goal\n",
  "current-status.md": "# Current Status\n",
  "tasks.md": "# Tasks\n\n## task1\n\nTask summary.\n\nTask body.\n",
  "decisions.md": "# Decisions\n",
  "open-questions.md": "# Open Questions\n",
  "risks.md": "# Risks\n",
  "knowledge-notes.md": "# Knowledge and Notes\n",
  "excluded.md": "# Excluded\n",
};

async function v3Workspace({ skip = [] } = {}) {
  // Canonical, matching what resolveContextMap produces for source.rootPath.
  const root = await realpath(await mkdtemp(join(tmpdir(), "viewer-content-index-")));
  const handoffDir = join(root, ".handoff");
  const contentDir = join(handoffDir, CONTENT_DIR);
  await mkdir(contentDir, { recursive: true });
  await writeFile(join(handoffDir, "context-map.md"), V3_MAP);
  for (const [name, body] of Object.entries(CONTENT)) {
    if (skip.includes(name)) continue;
    await writeFile(join(contentDir, name), body);
  }
  return { root, handoffDir, contentDir };
}

test("indexes a safe v3 workspace and serves the task body", async () => {
  const { handoffDir, root } = await v3Workspace();
  const index = new ContentIndex({ handoffDir, rootPath: root });
  await index.refresh();
  const detail = index.get("task1");
  assert.equal(detail.section, "tasks");
  assert.equal(detail.summary, "Task summary.");
  assert.equal(detail.body, "Task body.");
  assert.equal(detail.diagnostic, null);
});

test("a content file symlinked outside the workspace is rejected, not served", async () => {
  const outside = await mkdtemp(join(tmpdir(), "viewer-content-outside-"));
  const secret = join(outside, "secret.md");
  await writeFile(secret, "# Tasks\n\n## task1\n\nSECRET EXTERNAL BYTES\n");
  const { handoffDir, contentDir, root } = await v3Workspace({ skip: ["tasks.md"] });
  await symlink(secret, join(contentDir, "tasks.md"));

  const index = new ContentIndex({ handoffDir, rootPath: root });
  await index.refresh();
  const detail = index.get("task1");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "");
  assert.ok(
    !JSON.stringify(detail).includes("SECRET EXTERNAL BYTES"),
    "external bytes must never reach the node-detail surface",
  );
});

test("a content directory redirected outside the workspace never serves external bytes", async () => {
  const { handoffDir, contentDir, root } = await v3Workspace();
  const outside = await mkdtemp(join(tmpdir(), "viewer-content-outside-dir-"));
  await writeFile(join(outside, "tasks.md"), "# Tasks\n\n## task1\n\nOUTSIDE DIR BYTES\n");
  await rename(contentDir, `${contentDir}-original`);
  await symlink(outside, contentDir);

  const index = new ContentIndex({ handoffDir, rootPath: root });
  await index.refresh();
  const detail = index.get("task1");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "");
  assert.ok(
    !JSON.stringify(detail).includes("OUTSIDE DIR BYTES"),
    "a redirected content directory must not leak external bytes",
  );
});

test("a content directory replaced after the first refresh stays contained", async () => {
  const { handoffDir, contentDir, root } = await v3Workspace();
  const index = new ContentIndex({ handoffDir, rootPath: root });
  await index.refresh();
  assert.equal(index.get("task1").body, "Task body.");
  const safeVersion = index.version;

  const outside = await mkdtemp(join(tmpdir(), "viewer-content-race-"));
  await writeFile(join(outside, "tasks.md"), "# Tasks\n\n## task1\n\nRACED EXTERNAL BYTES\n");
  await rename(contentDir, `${contentDir}-original`);
  await symlink(outside, contentDir);

  await index.refresh();
  const detail = index.get("task1");
  assert.notEqual(index.version, safeVersion, "the redirect must invalidate the cache");
  assert.equal(detail.diagnostic, "CONTENT_MISSING");
  assert.equal(detail.body, "");
  assert.ok(
    !JSON.stringify(detail).includes("RACED EXTERNAL BYTES"),
    "a parent-directory replacement must not leak external bytes",
  );
});

function injectedIndex(mapBody, goalBody) {
  return new ContentIndex({
    handoffDir: "/virtual/.handoff",
    rootPath: "/virtual",
    readFile: async (filePath) => {
      if (filePath.endsWith("context-map.md")) return mapBody;
      if (filePath.endsWith(CONTENT_FILES.goals)) return goalBody;
      return "";
    },
  });
}

test("content version disambiguates file boundaries (no concatenation collisions)", async () => {
  const first = injectedIndex("a", "bc");
  await first.refresh();
  const second = injectedIndex("ab", "c");
  await second.refresh();
  assert.match(first.version, /^[0-9a-f]{64}$/);
  assert.notEqual(
    first.version,
    second.version,
    "bytes moved across a file boundary must change the content version",
  );
});
