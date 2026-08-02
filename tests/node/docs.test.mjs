/**
 * Handoff Protocol v3.0.0 — documentation consistency tests.
 *
 * Asserts that the product/protocol versions agree across package.json,
 * package-lock.json, and SKILL.md; that the v3 layout (eight content files +
 * views/HANDOFF.md) and effort levels are documented; and that the current
 * storage-layout examples use schema 3.0.0.
 *
 * Run: node --test "tests/node/docs.test.mjs"
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(join(root, rel), "utf-8");

const CONTENT_FILES = [
  "current-goal.md",
  "current-status.md",
  "tasks.md",
  "decisions.md",
  "open-questions.md",
  "risks.md",
  "knowledge-notes.md",
  "excluded.md",
];

test("package.json, package-lock.json, and SKILL.md versions agree on 3.0.0", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  const skill = await read("SKILL.md");

  assert.equal(pkg.version, "3.0.0", "package.json version");
  assert.equal(lock.version, "3.0.0", "package-lock.json root version");
  assert.equal(lock.packages[""].version, "3.0.0", "package-lock.json packages[''] version");

  const skillVersion = skill.match(/^\s*version:\s*"([^"]+)"/m);
  assert.ok(skillVersion, "SKILL.md must declare a metadata version");
  assert.equal(skillVersion[1], "3.0.0", "SKILL.md metadata version");
});

test("SKILL.md and README document the v3 layout and all eight content files", async () => {
  const skill = await read("SKILL.md");
  const readme = await read("README.md");

  for (const doc of [skill, readme]) {
    assert.match(doc, /content\//, "must describe the content/ directory");
    assert.match(doc, /views\/HANDOFF\.md/, "must describe views/HANDOFF.md");
    for (const name of CONTENT_FILES) {
      assert.ok(doc.includes(name), `must document content file '${name}'`);
    }
  }
});

test("SKILL.md and README document effort levels and v3 migration", async () => {
  const skill = await read("SKILL.md");
  const readme = await read("README.md");

  for (const doc of [skill, readme]) {
    for (const level of ["min", "low", "med", "high", "max"]) {
      assert.match(doc, new RegExp(`\`?${level}\`?`), `must document effort level '${level}'`);
    }
    assert.match(doc, /migrat/i, "must describe migration");
    assert.match(doc, /3\.0\.0/, "must reference the v3 protocol version");
  }
});

test("current storage-layout config examples use schema 3.0.0", async () => {
  const skill = await read("SKILL.md");
  const readme = await read("README.md");

  // Every `"version": "..."` in the storage-config examples is 3.0.0.
  for (const doc of [skill, readme]) {
    const versions = [...doc.matchAll(/"version":\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(versions.length > 0, "must show at least one config example");
    for (const version of versions) {
      assert.equal(version, "3.0.0", `config example version must be 3.0.0, got ${version}`);
    }
  }
});

test("the v3 migration guide exists and covers the required topics", async () => {
  const guide = await read("docs/migrations/v2-to-v3.md");
  for (const topic of [
    "content/",
    "views/HANDOFF.md",
    "effort",
    "backup",
    "idempoten",
    "stable ID",
  ]) {
    assert.match(guide, new RegExp(topic, "i"), `migration guide must cover '${topic}'`);
  }
});
