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
import { readFile, mkdtemp, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
} from "../shared/unit-suite.mjs";
import { PROTOCOL_VERSION, parseContextMapV3 } from "../../scripts/context-map.mjs";

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

// ── v3 save behavior ─────────────────────────────────────────────────────────

test("save: user-edited labels and bodies survive subsequent saves", async () => {
  const dir = await initTempRepo();
  runSave(dir);

  const mapPath = join(dir, ".handoff", "context-map.md");
  const notesPath = join(dir, ".handoff", "content", "knowledge-notes.md");
  const map = await readFile(mapPath, "utf-8");
  const noteLine = map.match(/- `note1`[^\n]*/);
  assert(noteLine, "expected an inferred note node to edit");
  await writeFile(mapPath, map.replace(noteLine[0], "- `note1` User refined knowledge label"));
  await writeFile(notesPath, "# Knowledge and Notes\n\n## note1\n\nUser refined body.\n");

  runSave(dir);
  const after = parseContextMapV3(await readFile(mapPath, "utf-8"));
  const note = after.sections.notes.find((n) => n.id === "note1");
  assert(note, "user-edited node lost its ID");
  assertEqual(note.label, "User refined knowledge label", "user label was overwritten by inference");
  assertIncludes(await readFile(notesPath, "utf-8"), "User refined body.", "user body was overwritten by inference");
});

test("save: task completion and node deletion survive the next save", async () => {
  const dir = await initTempRepo();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.ts"), "// TODO: keep this task around\n");
  runSave(dir);

  const mapPath = join(dir, ".handoff", "context-map.md");
  const map = await readFile(mapPath, "utf-8");
  const checked = map.replace("- [ ] `task1`", "- [x] `task1`");
  assertNotIncludes(checked, "placeholder", "sanity");
  assert(checked !== map, "expected a task1 node to complete");
  // Complete task1 and delete the decision node added below.
  await writeFile(mapPath, checked.replace("## Decisions", "## Decisions\n\n- `decision1` Temporary human decision"));

  runSave(dir);
  const after = parseContextMapV3(await readFile(mapPath, "utf-8"));
  const task = after.sections.tasks.find((n) => n.id === "task1");
  assert(task, "task1 missing after completion");
  assertEqual(task.checked, true, "user task completion was not preserved");

  // Delete the decision node; its body stays behind as a reported orphan.
  await writeFile(
    join(dir, ".handoff", "content", "decisions.md"),
    "# Decisions\n\n## decision1\n\nTemporary decision body.\n"
  );
  const beforeDelete = await readFile(mapPath, "utf-8");
  await writeFile(mapPath, beforeDelete.replace("\n- `decision1` Temporary human decision\n", "\n"));
  const res = spawnSync(process.execPath, [saveScript], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `save failed: ${res.stderr}`);
  const final = parseContextMapV3(await readFile(mapPath, "utf-8"));
  assert(!final.sections.decisions.some((n) => n.id === "decision1"), "a deleted node was recreated from its leftover body");
  assertIncludes(res.stderr, "CONTENT_ORPHAN", "the leftover body must be reported as an orphan");
  assertIncludes(await readFile(join(dir, ".handoff", "content", "decisions.md"), "utf-8"), "decision1", "orphan body must be retained, not deleted");
});

test("save: a release commit never becomes the Current Goal", async () => {
  const dir = await initTempRepo();
  await writeFile(join(dir, "release.ts"), "export const release = true;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "release: prepare 3.0.0"]);

  runSave(dir);
  const map = parseContextMapV3(await readFile(join(dir, ".handoff", "context-map.md"), "utf-8"));
  assertEqual(map.sections.goals.length, 0, "a release commit became the Current Goal");
});

test("save: a v2 handoff migrates automatically on the first save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-v2mig-"));
  await cp(join(fixturesDir, "migration", "v2-complete"), dir, { recursive: true });
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: "2.0.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );

  const out = runSave(dir);
  assertIncludes(out, "migrated to Handoff Protocol v3.0.0", "save should announce the v3 migration");
  assertIncludes(out, "Backup:", "migration backup not reported");

  const handoff = join(dir, ".handoff");
  const map = parseContextMapV3(await readFile(join(handoff, "context-map.md"), "utf-8"));
  assert(map, "migration did not produce a readable v3 map");
  assertEqual(map.sections.goals[0].label, "Ship the context directory release");
  assertEqual(map.sections.tasks.length, 3);
  assert(existsSync(join(handoff, "content", "tasks.md")), "content files not installed");
  assert(existsSync(join(handoff, "views", "HANDOFF.md")), "generated view not installed");
  for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    assert(!existsSync(join(handoff, legacy)), `legacy root file '${legacy}' must be retired`);
  }
  const config = JSON.parse(await readFile(join(dir, ".handoff.config.json"), "utf-8"));
  assertEqual(config.version, "3.0.0", "config version not upgraded");
});
