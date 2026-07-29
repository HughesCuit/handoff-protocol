/**
 * Handoff Protocol — CLI command behavior tests (Node.js).
 *
 * Executable coverage for documented commands not exercised elsewhere:
 * `init`, `storage`, and the `auto`/`merge` load modes. Save modes and
 * verbosity, compiler flags (--focus/--budget/--full), the Obsidian adapter,
 * and `diff` are covered in context-map.test.mjs, adapter.test.mjs, and
 * diff.test.mjs.
 *
 * Run: node --test "tests/node/*.test.mjs"
 */

import { test } from "node:test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
} from "../shared/unit-suite.mjs";
import { PROTOCOL_VERSION } from "../../scripts/context-map.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = join(root, "tests", "fixtures");
const saveScript = join(root, "scripts", "node", "save.mjs");
const loadScript = join(root, "scripts", "node", "load.mjs");

function runSave(cwd, args = []) {
  return execFileSync(process.execPath, [saveScript, ...args], { cwd, encoding: "utf-8" });
}

function runLoad(cwd, mode = "default") {
  return execFileSync(process.execPath, [loadScript, mode], { cwd, encoding: "utf-8" });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

async function initTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "handoff-cmd-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture-app" }) + "\n");
  await writeFile(join(dir, ".gitignore"), ".handoff/\n");
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: "1.5.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "feat: initial commit"]);
  return dir;
}

// ── /handoff init ────────────────────────────────────────────────────────────

test("init: direct mode creates .handoff/ and a portable config without prompting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-init-"));
  const out = runSave(dir, ["init", "direct"]);
  assertIncludes(out, "Initialized direct storage mode");
  assert(existsSync(join(dir, ".handoff")), ".handoff/ was not created");

  const raw = await readFile(join(dir, ".handoff.config.json"), "utf-8");
  const config = JSON.parse(raw);
  assertEqual(config.version, PROTOCOL_VERSION);
  assertEqual(config.storage.mode, "direct");
  assertEqual(config.storage.path, ".handoff");
  assertNotIncludes(raw, dir, "config must not embed machine-specific absolute paths");
});

// ── /handoff storage ─────────────────────────────────────────────────────────

test("storage: displays the current mode and path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-storage-"));
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: PROTOCOL_VERSION, storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  const out = runSave(dir, ["storage"]);
  assertIncludes(out, "Handoff storage:");
  assertIncludes(out, "mode: direct");
  assertIncludes(out, "path: .handoff");
});

test("storage: reports unconfigured state when no config exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-storage-none-"));
  const out = runSave(dir, ["storage"]);
  assertIncludes(out, "Handoff storage is not configured.");
  assertIncludes(out, "/handoff init");
});

// ── /handoff load auto ───────────────────────────────────────────────────────

test("load auto: appends the auto-analysis block", () => {
  const out = runLoad(join(fixturesDir, "handoffs", "map-only"), "auto");
  assertIncludes(out, "Current understanding:");
  assertIncludes(out, "Auto-analysis:");
  assertIncludes(out, "Last saved:");
  assertIncludes(out, "Modified files:");
  assertIncludes(out, "Branch:");
});

// ── /handoff load merge ──────────────────────────────────────────────────────

test("load merge: surfaces commits made since the handoff", async () => {
  const dir = await initTempRepo();
  runSave(dir);

  await writeFile(join(dir, "feature.ts"), "export const feature = true;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "feat: advance the work"]);

  const out = runLoad(dir, "merge");
  assertIncludes(out, "Current understanding:");
  assertIncludes(out, "Sync with 1 new commit(s) since handoff");
});
