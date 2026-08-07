/**
 * Handoff Protocol v3.0.0 — migration evaluator tests.
 *
 * Exercises scripts/evaluate-v3-migration.mjs against copied fixtures in
 * isolated temp dirs. The evaluator must never modify its source project.
 *
 * Run: node --test tests/evaluate-migration.test.mjs
 */

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateV3Migration } from "../scripts/evaluate-v3-migration.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "tests", "fixtures");

async function copyFixture(name) {
  const dir = await mkdtemp(join(tmpdir(), "v3-eval-test-"));
  await cp(join(fixturesDir, name), dir, { recursive: true });
  return dir;
}

async function snapshotDir(dir) {
  const out = {};
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else out[rel] = await readFile(full, "utf-8");
    }
  }
  await walk(dir, "");
  return out;
}

test("evaluator reports migration metrics for a v2 handoff and never touches the source", async () => {
  const source = await copyFixture("migration/v2-complete");
  const before = await snapshotDir(source);

  const result = await evaluateV3Migration(source);

  // Source project is byte-for-byte untouched.
  const after = await snapshotDir(source);
  assert.deepEqual(after, before, "evaluator modified its source project");

  const m = result.metrics;
  assert.ok(m.nodeCount > 0, "migrated handoff has nodes");
  assert.equal(m.duplicateNodeRate, 0, "no duplicate IDs expected");
  assert.equal(m.preservedUserEditRate, 1, "every original node text must survive");
  assert.equal(m.orphanContentCount, 0, "no orphan content expected");

  // Byte growth is reported per file and in total.
  assert.ok(m.byteGrowth.total.after > 0, "total after bytes reported");
  assert.ok(typeof m.byteGrowth.total.delta === "number", "total delta reported");
  assert.ok(Object.keys(m.byteGrowth.files).length > 0, "per-file growth reported");
  assert.ok("context-map.md" in m.byteGrowth.files, "context-map.md growth reported");

  // Migration and repeated save are idempotent.
  assert.equal(m.idempotent, true, "re-migration must be a no-op");

  // Node and Deno produce the same normalized migration output (or Deno is absent).
  assert.ok(m.nodeDenoEqual === true || m.nodeDenoEqual === "skipped", `nodeDenoEqual: ${m.nodeDenoEqual}`);
});

test("evaluator handles a handoff with user-edited labels and an empty goal", async () => {
  const source = await copyFixture("handoffs/map-only");
  const result = await evaluateV3Migration(source);
  const m = result.metrics;
  assert.ok(m.nodeCount > 0);
  assert.equal(m.duplicateNodeRate, 0);
  assert.equal(m.preservedUserEditRate, 1, "user-edited map text must be preserved");
  assert.equal(m.idempotent, true);
});
