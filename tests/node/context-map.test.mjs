/**
 * Handoff Protocol v1.5 — Node.js test suite.
 *
 * Runs the shared unit suite (identical to the Deno suite) plus Node-specific
 * integration tests that exercise scripts/node/save.mjs and load.mjs against
 * the shared fixtures.
 *
 * Run: node --test "tests/node/*.test.mjs"
 */

import { test } from "node:test";
import { readFile, mkdtemp, writeFile, mkdir, rm, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  defineUnitTests,
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
} from "../shared/unit-suite.mjs";
import { parseContextMap, PROTOCOL_VERSION, SECTION_LABELS, SECTION_KEYS } from "../../scripts/context-map.mjs";
import { GENERATED_MARKER, sha256Hex } from "../../scripts/views.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = join(root, "tests", "fixtures");
const readFixture = (rel) => readFile(join(fixturesDir, rel), "utf-8");

defineUnitTests((name, fn) => test(name, fn), readFixture);

// ── Helpers ──────────────────────────────────────────────────────────────────

function runLoad(cwd, mode = "default") {
  return execFileSync(process.execPath, [join(root, "scripts", "node", "load.mjs"), mode], {
    cwd,
    encoding: "utf-8",
  });
}

function runSave(cwd, args = []) {
  return execFileSync(process.execPath, [join(root, "scripts", "node", "save.mjs"), ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

async function initTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "handoff-save-"));
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

function understandingOf(out) {
  const m = out.match(/Current understanding:\n([\s\S]*?)\n\n/);
  return m ? m[1].trim() : "";
}

// ── Load integration ─────────────────────────────────────────────────────────

test("load: legacy 1.x four-file handoff (no map) still loads", () => {
  const out = runLoad(join(fixturesDir, "handoffs", "legacy-1x"));
  assertIncludes(out, "feat: add rate limiting middleware");
  assertIncludes(out, "Pending tasks: 3");
  assertIncludes(out, "Branch: feature/rate-limiting");
});

test("load: map-only handoff loads successfully", () => {
  const out = runLoad(join(fixturesDir, "handoffs", "map-only"));
  assertIncludes(out, "Ship the v1.5 context map release");
  assertIncludes(out, "Pending tasks: 1");
});

test("load: mixed handoff prefers map semantics, supplements machine state", () => {
  const out = runLoad(join(fixturesDir, "handoffs", "mixed"));
  assertIncludes(out, "Selective context compilation for v3");
  assertNotIncludes(understandingOf(out), "Legacy JSON goal");
  assertIncludes(out, "Branch: feature/map"); // machine state from context.json
  assertIncludes(out, "Pending tasks: 1");
});

// ── Save integration ─────────────────────────────────────────────────────────

test("save: generates context-map.md with all sections, reconciles idempotently", async () => {
  const dir = await initTempRepo();

  runSave(dir);
  const mapPath = join(dir, ".handoff", "context-map.md");
  assert(existsSync(mapPath), "context-map.md was not written");
  const first = await readFile(mapPath, "utf-8");
  for (const key of SECTION_KEYS) {
    assertIncludes(first, `## ${SECTION_LABELS[key].en}`, `missing section '${key}'`);
  }
  // Legacy files still produced at med verbosity.
  for (const f of ["HANDOFF.md", "context.json", "tasks.md", "decisions.md"]) {
    assert(existsSync(join(dir, ".handoff", f)), `${f} missing after save`);
  }

  // Second save with unchanged state: map is byte-identical (idempotent).
  runSave(dir);
  const second = await readFile(mapPath, "utf-8");
  assertEqual(second, first, "repeated save was not idempotent");

  const parsed = parseContextMap(second);
  assertEqual(parsed.sections.goal.length, 1, "goal duplicated across saves");
});

test("save: low verbosity still writes the context map (and skips legacy task files)", async () => {
  const dir = await initTempRepo();
  runSave(dir, ["--verbosity", "low"]);

  const mapPath = join(dir, ".handoff", "context-map.md");
  assert(existsSync(mapPath), "low verbosity save did not write context-map.md");
  const map = await readFile(mapPath, "utf-8");
  assertIncludes(map, "## Current Goal");
  assertIncludes(map, "## Excluded");
  assert((await readFile(join(dir, ".handoff", "HANDOFF.md"), "utf-8")).startsWith(GENERATED_MARKER), "low verbosity HANDOFF.md is not a marked generated view");
  assert(!existsSync(join(dir, ".handoff", "tasks.md")), "low verbosity should skip tasks.md");
  assert(!existsSync(join(dir, ".handoff", "decisions.md")), "low verbosity should skip decisions.md");
});

for (const [label, args] of [
  ["compact mode", ["compact"]],
  ["full mode", ["full"]],
  ["diff mode", ["diff"]],
  ["high verbosity", ["--verbosity", "high"]],
]) {
  test(`save: ${label} writes a readable context map`, async () => {
    const dir = await initTempRepo();
    runSave(dir, args);
    const mapPath = join(dir, ".handoff", "context-map.md");
    assert(existsSync(mapPath), `${label} did not write context-map.md`);
    const parsed = parseContextMap(await readFile(mapPath, "utf-8"));
    assert(parsed, `${label} wrote an unreadable context map`);
    for (const key of SECTION_KEYS) {
      assert(Array.isArray(parsed.sections[key]), `${label} omitted section '${key}'`);
    }
    // Compatibility views are still produced at every mode/verbosity.
    for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
      const viewPath = join(dir, ".handoff", name);
      assert(existsSync(viewPath), `${label} did not write ${name}`);
      assert((await readFile(viewPath, "utf-8")).startsWith(GENERATED_MARKER), `${label} wrote ${name} without the generated marker`);
    }
  });
}

test("save: submodule storage includes context-map.md in the submodule commit", async (t) => {
  // Seed a local "remote" so `git submodule add` works without network.
  const seed = await mkdtemp(join(tmpdir(), "handoff-seed-"));
  const remote = await mkdtemp(join(tmpdir(), "handoff-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(seed, ["init", "-q"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  git(seed, ["config", "user.name", "Test"]);
  await writeFile(join(seed, "README.md"), "handoff store\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "init"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);

  const dir = await initTempRepo();
  // The fixture .gitignore ignores .handoff/ (direct-mode convention); git
  // refuses to add a submodule at an ignored path, so un-ignore it here.
  await writeFile(join(dir, ".gitignore"), "\n");
  git(dir, ["-c", "protocol.file.allow=always", "submodule", "-q", "add", remote, ".handoff"]);
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify(
      { version: "1.5.0", storage: { mode: "submodule", path: ".handoff", remote } },
      null,
      2
    ) + "\n"
  );

  runSave(dir);

  assert(existsSync(join(dir, ".handoff", "context-map.md")), "map not written into submodule");
  const tracked = git(join(dir, ".handoff"), ["ls-files"]);
  assertIncludes(tracked, "context-map.md", "context-map.md not committed in submodule");
  assertIncludes(tracked, "HANDOFF.md", "legacy files not committed in submodule");
});

test("save: TODO scan only picks up comment tags and skips excluded directories", async () => {
  const dir = await initTempRepo();
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "app.ts"),
    [
      "// TODO: wire up the real scanner",
      'const fake = "FIXME: string false positive";',
      "const tpl = `HACK: template false positive`;",
      "",
    ].join("\n")
  );
  await mkdir(join(dir, "tests", "fixtures"), { recursive: true });
  await writeFile(join(dir, "tests", "fixtures", "sample.ts"), "// TODO: fixture dir must be excluded\n");

  runSave(dir);
  const tasksMd = await readFile(join(dir, ".handoff", "tasks.md"), "utf-8");
  assertIncludes(tasksMd, "wire up the real scanner (src/app.ts:1)");
  assertNotIncludes(tasksMd, "string false positive");
  assertNotIncludes(tasksMd, "template false positive");
  assertNotIncludes(tasksMd, "fixture dir must be excluded");
});

// ── Canonical state and generated views (v2) ────────────────────────────────

const SEMANTIC_JSON_FIELDS = [
  "current_goal", "status", "completed", "modified_files", "todos",
  "blockers", "decisions", "next_steps", "risks", "notes",
];

test("save: v2 context.json drops semantic fields and stores SHA-256 view hashes", async () => {
  const dir = await initTempRepo();
  runSave(dir);

  const json = JSON.parse(await readFile(join(dir, ".handoff", "context.json"), "utf-8"));
  for (const field of SEMANTIC_JSON_FIELDS) {
    assert(!(field in json), `semantic field '${field}' must not appear in v2 context.json`);
  }
  assert(json.project && json.timestamp && json.agent && json.git, "metadata missing from context.json");
  assertEqual(JSON.stringify(json.diagnostics), JSON.stringify({ migration: [], conflicts: [] }));

  for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    const content = await readFile(join(dir, ".handoff", name), "utf-8");
    assert(content.startsWith(GENERATED_MARKER), `${name} does not begin with the generated marker`);
    assertEqual(json.views[name], sha256Hex(content), `stored hash does not match written ${name}`);
  }
});

test("save: manual view edits warn and are never imported into the map", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  await writeFile(join(dir, ".handoff", "HANDOFF.md"), "manual vandalism\n");

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `save failed: ${res.stderr}`);
  assertIncludes(res.stderr, "HANDOFF.md");

  const view = await readFile(join(dir, ".handoff", "HANDOFF.md"), "utf-8");
  assertNotIncludes(view, "manual vandalism", "manual edit survived regeneration");
  const map = await readFile(join(dir, ".handoff", "context-map.md"), "utf-8");
  assertNotIncludes(map, "manual vandalism", "manual view edit was imported into the map");
});

test("load: warns when a generated view was manually edited, semantics still come from the map", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  const tasksPath = join(dir, ".handoff", "tasks.md");
  await writeFile(tasksPath, (await readFile(tasksPath, "utf-8")) + "\n- [ ] manual injected task\n");

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stderr, "tasks.md");
  assertIncludes(res.stdout, "Current understanding:");
  assertNotIncludes(res.stdout, "manual injected task");
});

test("load: v2 handoff with a missing map falls back to the HANDOFF.md view", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  await rm(join(dir, ".handoff", "context-map.md"));

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Current understanding:");
  assertIncludes(res.stdout, "Project: fixture-app");
});

test("save: low-verbosity saves preserve view hashes and tamper detection for skipped views", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  runSave(dir, ["--verbosity", "low"]);

  // The skipped views keep their hash entries in context.json.
  const json = JSON.parse(await readFile(join(dir, ".handoff", "context.json"), "utf-8"));
  for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    const content = await readFile(join(dir, ".handoff", name), "utf-8");
    assertEqual(json.views[name], sha256Hex(content), `low save dropped the ${name} hash entry`);
  }

  // Tampering with a skipped view still warns on load (and on the next save).
  const tasksPath = join(dir, ".handoff", "tasks.md");
  await writeFile(tasksPath, (await readFile(tasksPath, "utf-8")) + "\n- [ ] manual injected task\n");
  const loadRes = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(loadRes.status, 0, `load failed: ${loadRes.stderr}`);
  assertIncludes(loadRes.stderr, "tasks.md");
  const saveRes = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs"), "--verbosity", "low"], { cwd: dir, encoding: "utf-8" });
  assertEqual(saveRes.status, 0, `save failed: ${saveRes.stderr}`);
  assertIncludes(saveRes.stderr, "tasks.md");
});

// ── Legacy migration (v2) ─────────────────────────────────────────────────

async function copyHandoffFixture(name) {
  const dir = await mkdtemp(join(tmpdir(), `handoff-migrate-${name}-`));
  await cp(join(fixturesDir, "handoffs", name), dir, { recursive: true });
  return dir;
}

test("migrate: save migrates a legacy 1.x handoff with backup and stays idempotent", async () => {
  const dir = await copyHandoffFixture("legacy-1x");
  const out = runSave(dir);
  assertIncludes(out, "migrat", "save should announce the migration");

  const map = parseContextMap(await readFile(join(dir, ".handoff", "context-map.md"), "utf-8"));
  assert(map, "migration did not produce a readable context map");
  assertEqual(map.sections.goal[0].text, "feat: add rate limiting middleware");
  const taskTexts = map.sections.tasks.map((n) => n.text);
  assert(taskTexts.some((t) => t.includes("Add Redis backend for distributed rate limiting")), "legacy task lost");
  assert(map.sections.tasks.every((n) => !n.checked), "legacy tasks should stay pending");
  assert(
    map.sections.decisions.some((n) => n.text.includes("Simpler to reason about bursty traffic")),
    "decision rationale lost"
  );
  assert(
    map.sections.risks.some((n) => n.text.includes("1 high-priority TODO/FIXME items pending")),
    "legacy risk lost"
  );

  // Originals are backed up under .handoff/history/migrations/<UTC-timestamp>/.
  const migrationsRoot = join(dir, ".handoff", "history", "migrations");
  assertEqual((await readdir(migrationsRoot)).length, 1, "expected exactly one backup directory");
  const backupDir = join(migrationsRoot, (await readdir(migrationsRoot))[0]);
  assertIncludes(await readFile(join(backupDir, "HANDOFF.md"), "utf-8"), "v1.2.0", "backup must hold the original HANDOFF.md");
  assertIncludes(await readFile(join(backupDir, "context.json"), "utf-8"), "my-api", "backup must hold the original context.json");
  assert(existsSync(join(backupDir, ".handoff.config.json")), "config not backed up");

  // Versions upgrade to v2.
  const config = JSON.parse(await readFile(join(dir, ".handoff.config.json"), "utf-8"));
  assertEqual(config.version, PROTOCOL_VERSION, "config version not upgraded");
  const json = JSON.parse(await readFile(join(dir, ".handoff", "context.json"), "utf-8"));
  assertEqual(json.version, PROTOCOL_VERSION, "context.json version not upgraded");
  assert(json.diagnostics.migration.length > 0, "migration diagnostics missing from context.json");

  // Repeated save: already migrated, no second backup.
  runSave(dir);
  assertEqual((await readdir(migrationsRoot)).length, 1, "repeated save created a second migration backup");

  // The migrated handoff loads with its legacy semantics intact.
  const loadOut = runLoad(dir);
  assertIncludes(loadOut, "feat: add rate limiting middleware");
  assertIncludes(loadOut, "Pending tasks: 3");
});

test("migrate: conflicting handoff keeps map semantics and records labeled conflicts", async () => {
  const dir = await copyHandoffFixture("conflicting");
  runSave(dir);

  const map = parseContextMap(await readFile(join(dir, ".handoff", "context-map.md"), "utf-8"));
  assertEqual(map.sections.goal.length, 1, "singleton goal duplicated");
  assertEqual(map.sections.goal[0].text, "Ship the map-approved compiler release", "map goal must win");

  const questions = map.sections.questions;
  assert(questions.some((n) => n.text === "How should v3 rank branches?"), "map question lost");
  const conflictIdx = questions.findIndex((n) => n.text === "Migration conflict");
  assert(conflictIdx >= 0, "Migration conflict node missing from Open Questions");
  const children = questions.slice(conflictIdx + 1).filter((n) => n.depth > 0).map((n) => n.text);
  assert(
    children.some((t) => t.includes("JSON draft goal superseded by the map") && t.includes("(source: context.json)")),
    `context.json conflict not labeled: ${JSON.stringify(children)}`
  );
  assert(
    children.some((t) => t.includes("HANDOFF view goal superseded by the map") && t.includes("(source: HANDOFF.md)")),
    `HANDOFF.md conflict not labeled: ${JSON.stringify(children)}`
  );

  assertEqual(map.sections.excluded[0].text, "No vector database in v3", "exclusion lost");
  const tasks = map.sections.tasks;
  const shared = tasks.filter((n) => n.text.includes("Wire the context compiler into load"));
  assertEqual(shared.length, 1, "overlapping task not deduplicated");
  assertEqual(shared[0].checked, false, "map task state lost to the legacy duplicate");
  assert(tasks.some((n) => n.text.includes("Legacy-only task from context.json")), "unique context.json task lost");
  assert(tasks.some((n) => n.text.includes("Legacy-only task from HANDOFF.md")), "unique HANDOFF.md task lost");
});

test("load: legacy handoffs warn that migration is available (read-only)", () => {
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], {
    cwd: join(fixturesDir, "handoffs", "legacy-1x"),
    encoding: "utf-8",
  });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stderr, "migrat", "load should point at migration for legacy handoffs");
  assertIncludes(res.stdout, "feat: add rate limiting middleware", "legacy load behavior changed");
});

test("load: already-migrated v2 handoff does not warn about migration", () => {
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], {
    cwd: join(fixturesDir, "handoffs", "migrated"),
    encoding: "utf-8",
  });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertNotIncludes(res.stderr, "migrat", "v2 handoff should not trigger a migration warning");
  assertIncludes(res.stdout, "Already migrated v2 goal");
});

// ── Config validation integration ────────────────────────────────────────────

async function writeInvalidConfig(dir, config) {
  await writeFile(join(dir, ".handoff.config.json"), JSON.stringify(config, null, 2) + "\n");
}

test("save: rejects a non-portable .handoff.config.json before writing", async () => {
  const dir = await initTempRepo();
  await writeInvalidConfig(dir, { version: "1.5.1", storage: { mode: "direct", path: "/Users/alice/.handoff" } });
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.path");
  assert(!existsSync(join(dir, ".handoff", "HANDOFF.md")), "save wrote output despite invalid config");
});

test("save: rejects a malformed storage mode", async () => {
  const dir = await initTempRepo();
  await writeInvalidConfig(dir, { version: "1.5.1", storage: { mode: "network-drive", path: ".handoff" } });
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.mode");
});

test("load: rejects a non-portable .handoff.config.json", async () => {
  const dir = await initTempRepo();
  await writeInvalidConfig(dir, { version: "1.5.1", storage: { mode: "direct", path: "~/handoff-data" } });
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.path");
});

test("storage: reports an invalid configuration instead of displaying it", async () => {
  const dir = await initTempRepo();
  await writeInvalidConfig(dir, { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, token: "ghp_0123456789abcdef0123456789abcdef0123" });
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs"), "storage"], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertNotIncludes(res.stderr + res.stdout, "ghp_0123456789abcdef0123456789abcdef0123", "secret value was echoed back");
});

// ── Context compiler flags (v2.1) ────────────────────────────────────────────

function runLoadArgs(cwd, args = []) {
  return spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs"), ...args], {
    cwd,
    encoding: "utf-8",
  });
}

test("load --focus: compiles the map and prints deterministic diagnostics", () => {
  const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--focus", "vector database"]);
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Focus: vector database");
  assertIncludes(res.stdout, "Budget: 4000 estimated tokens");
  assertIncludes(res.stdout, "Selected: goal[0], status[0], tasks[0], excluded[0]");
  assertIncludes(res.stdout, "Omitted: 5 node(s)");
  assertIncludes(res.stdout, "Estimated tokens:");
  assertIncludes(res.stdout, "Overflow: no");
  assertNotIncludes(res.stdout, "Fallback:");
  // Semantics still load from the (compiled) map.
  assertIncludes(res.stdout, "Ship the v1.5 context map release");
});

test("load --focus: no reliable match falls back to the full map with a reason", () => {
  const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--focus", "zebra quokka"]);
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Fallback:");
  assertIncludes(res.stdout, "Omitted: 0 node(s)");
});

test("load --budget: values below 512 or non-numeric are rejected", () => {
  for (const bad of ["100", "511", "abc", ""]) {
    const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--budget", bad]);
    assertEqual(res.status, 1, `budget '${bad}' must exit 1: ${res.stdout}${res.stderr}`);
    assertIncludes(res.stderr, "budget");
  }
  const ok = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--budget", "512"]);
  assertEqual(ok.status, 0, `budget 512 must be accepted: ${ok.stderr}`);
  assertIncludes(ok.stdout, "Context compiler:");
});

test("load --full: selects the entire map regardless of focus", () => {
  const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--full", "--focus", "zebra"]);
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Omitted: 0 node(s)");
  assertIncludes(res.stdout, "Overflow: no");
  assertNotIncludes(res.stdout, "Fallback:");
});

test("load: without compiler flags the output carries no compiler diagnostics", () => {
  for (const mode of ["default", "auto", "merge"]) {
    const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), [mode]);
    assertEqual(res.status, 0, `load failed: ${res.stderr}`);
    assertNotIncludes(res.stdout, "Context compiler:");
  }
});

test("load: unknown flags are rejected", () => {
  const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), ["--bogus"]);
  assertEqual(res.status, 1, `unknown flag must exit 1: ${res.stdout}${res.stderr}`);
});

// ── Cross-runtime parity ─────────────────────────────────────────────────────

function denoAvailable() {
  const res = spawnSync("deno", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

test("parity: Deno and Node loaders produce equivalent output for shared fixtures", async (t) => {
  if (!denoAvailable()) {
    t.skip("deno not installed");
    return;
  }
  for (const fixture of ["legacy-1x", "map-only", "mixed"]) {
    const cwd = join(fixturesDir, "handoffs", fixture);
    const nodeOut = runLoad(cwd);
    const denoRes = spawnSync(
      "deno",
      ["run", "--allow-read", "--allow-run", join(root, "scripts", "load.ts")],
      { cwd, encoding: "utf-8" }
    );
    assertEqual(denoRes.status, 0, `deno load failed for ${fixture}: ${denoRes.stderr}`);
    assertEqual(
      understandingOf(denoRes.stdout),
      understandingOf(nodeOut),
      `understanding diverged for fixture '${fixture}'`
    );
    const pend = (s) => (s.match(/Pending tasks: (\d+)/) || [])[1] || "0";
    assertEqual(pend(denoRes.stdout), pend(nodeOut), `pending count diverged for '${fixture}'`);
  }
});
