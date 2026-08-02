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
import {
  parseContextMapV3,
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
  V3_SECTION_LABELS,
} from "../../scripts/context-map.mjs";
import { V3_GENERATED_MARKER, sha256Hex } from "../../scripts/views.mjs";
import { CONTENT_FILES } from "../../scripts/content-files.mjs";

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

test("save: generates the v3 layout, reconciles idempotently, and never infers a goal", async () => {
  const dir = await initTempRepo();

  runSave(dir);
  const handoff = join(dir, ".handoff");
  const mapPath = join(handoff, "context-map.md");
  assert(existsSync(mapPath), "context-map.md was not written");
  const first = await readFile(mapPath, "utf-8");
  for (const key of V3_SECTION_KEYS) {
    assertIncludes(first, `## ${V3_SECTION_LABELS[key].en}`, `missing section '${key}'`);
  }
  // Canonical v3 files are produced; legacy root views are not.
  for (const name of Object.values(CONTENT_FILES)) {
    assert(existsSync(join(handoff, "content", name)), `content/${name} missing after save`);
  }
  for (const name of ["views/HANDOFF.md", "context.json"]) {
    assert(existsSync(join(handoff, name)), `${name} missing after save`);
  }
  for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    assert(!existsSync(join(handoff, legacy)), `legacy root file '${legacy}' must not be created in v3`);
  }

  // Second save with unchanged state: map is byte-identical (idempotent).
  runSave(dir);
  const second = await readFile(mapPath, "utf-8");
  assertEqual(second, first, "repeated save was not idempotent");

  const parsed = parseContextMapV3(second);
  assertEqual(parsed.sections.goals.length, 0, "the latest commit must never become the Current Goal");
});

test("save: snapshots semantic state only when it changes", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  const snapDir = join(dir, ".handoff", "history", "snapshots");

  const first = await readdir(snapDir);
  assertEqual(first.length, 1, "first save should write one snapshot");
  assert(first[0].endsWith(".json"), "snapshot should be JSON");
  const snapshot = JSON.parse(await readFile(join(snapDir, first[0]), "utf-8"));
  assertEqual(snapshot.version, V3_PROTOCOL_VERSION);
  assert(snapshot.digest && snapshot.state, "snapshot missing digest/state");
  assert(Array.isArray(snapshot.state.nodes), "v3 snapshot must normalize nodes with stable IDs");

  runSave(dir); // unchanged
  assertEqual((await readdir(snapDir)).length, 1, "unchanged save must not snapshot");

  // A user edit to the map changes semantic state.
  const mapPath = join(dir, ".handoff", "context-map.md");
  const map = await readFile(mapPath, "utf-8");
  await writeFile(
    mapPath,
    map.replace("## Knowledge and Notes", "## Knowledge and Notes\n\n- `note9` User note from a human edit")
  );
  runSave(dir);
  assertEqual((await readdir(snapDir)).length, 2, "changed save should write a second snapshot");
});

test("save: low verbosity still writes the canonical v3 layout", async () => {
  const dir = await initTempRepo();
  runSave(dir, ["--verbosity", "low"]);

  const handoff = join(dir, ".handoff");
  const map = await readFile(join(handoff, "context-map.md"), "utf-8");
  assertIncludes(map, "## Current Goal");
  assertIncludes(map, "## Excluded");
  for (const name of Object.values(CONTENT_FILES)) {
    assert(existsSync(join(handoff, "content", name)), `low verbosity must still write content/${name}`);
  }
  assert(
    (await readFile(join(handoff, "views", "HANDOFF.md"), "utf-8")).startsWith(V3_GENERATED_MARKER),
    "low verbosity HANDOFF.md is not a marked generated view"
  );
  for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    assert(!existsSync(join(handoff, legacy)), `legacy root file '${legacy}' must not exist in v3`);
  }
});

for (const [label, args] of [
  ["compact mode", ["compact"]],
  ["full mode", ["full"]],
  ["diff mode", ["diff"]],
  ["high verbosity", ["--verbosity", "high"]],
]) {
  test(`save: ${label} writes a readable v3 layout`, async () => {
    const dir = await initTempRepo();
    runSave(dir, args);
    const handoff = join(dir, ".handoff");
    const mapPath = join(handoff, "context-map.md");
    assert(existsSync(mapPath), `${label} did not write context-map.md`);
    const parsed = parseContextMapV3(await readFile(mapPath, "utf-8"));
    assert(parsed, `${label} wrote an unreadable context map`);
    for (const key of V3_SECTION_KEYS) {
      assert(Array.isArray(parsed.sections[key]), `${label} omitted section '${key}'`);
      assert(existsSync(join(handoff, "content", CONTENT_FILES[key])), `${label} omitted a content file for '${key}'`);
    }
    const viewPath = join(handoff, "views", "HANDOFF.md");
    assert(existsSync(viewPath), `${label} did not write views/HANDOFF.md`);
    assert((await readFile(viewPath, "utf-8")).startsWith(V3_GENERATED_MARKER), `${label} wrote the view without the generated marker`);
    for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
      assert(!existsSync(join(handoff, legacy)), `${label} created legacy root file '${legacy}'`);
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
  const trackedFiles = tracked.split("\n");
  assertIncludes(tracked, "context-map.md", "context-map.md not committed in submodule");
  assertIncludes(tracked, "content/tasks.md", "content files not committed in submodule");
  assertIncludes(tracked, "views/HANDOFF.md", "generated view not committed in submodule");
  assertIncludes(tracked, "context.json", "context.json not committed in submodule");
  assert(!trackedFiles.includes("tasks.md"), "legacy root tasks.md must not be committed in v3");
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
  const tasksMd = await readFile(join(dir, ".handoff", "content", "tasks.md"), "utf-8");
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

test("save: v3 context.json drops semantic fields and stores SHA-256 file hashes", async () => {
  const dir = await initTempRepo();
  runSave(dir);

  const handoff = join(dir, ".handoff");
  const json = JSON.parse(await readFile(join(handoff, "context.json"), "utf-8"));
  for (const field of SEMANTIC_JSON_FIELDS) {
    assert(!(field in json), `semantic field '${field}' must not appear in v3 context.json`);
  }
  assertEqual(json.protocolVersion, V3_PROTOCOL_VERSION);
  assert(json.project && json.timestamp && json.agent && json.git, "metadata missing from context.json");
  assert(json.idCounters && typeof json.idCounters === "object", "monotonic ID counters missing");
  assertEqual(JSON.stringify(json.diagnostics), JSON.stringify({ migration: [], conflicts: [], integrity: [] }));

  const hashed = ["context-map.md", ...Object.values(CONTENT_FILES).map((n) => `content/${n}`), "views/HANDOFF.md"];
  assertEqual(JSON.stringify(Object.keys(json.hashes).sort()), JSON.stringify(hashed.sort()));
  for (const name of hashed) {
    const content = await readFile(join(handoff, name), "utf-8");
    assertEqual(json.hashes[name], sha256Hex(content), `stored hash does not match written ${name}`);
  }
  assert(
    (await readFile(join(handoff, "views", "HANDOFF.md"), "utf-8")).startsWith(V3_GENERATED_MARKER),
    "views/HANDOFF.md does not begin with the generated marker"
  );
});

test("save: manual view edits warn and are never imported into the map", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  await writeFile(join(dir, ".handoff", "views", "HANDOFF.md"), "manual vandalism\n");

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `save failed: ${res.stderr}`);
  assertIncludes(res.stderr, "HANDOFF.md");

  const view = await readFile(join(dir, ".handoff", "views", "HANDOFF.md"), "utf-8");
  assertNotIncludes(view, "manual vandalism", "manual edit survived regeneration");
  const map = await readFile(join(dir, ".handoff", "context-map.md"), "utf-8");
  assertNotIncludes(map, "manual vandalism", "manual view edit was imported into the map");
});

test("load: warns when a generated view was manually edited, semantics still come from the map", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  const viewPath = join(dir, ".handoff", "views", "HANDOFF.md");
  await writeFile(viewPath, (await readFile(viewPath, "utf-8")) + "\n- manual injected task\n");

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stderr, "HANDOFF.md");
  assertIncludes(res.stdout, "Current understanding:");
  assertNotIncludes(res.stdout, "manual injected task");
});

test("load: v3 handoff with a missing map falls back to the generated view", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  await rm(join(dir, ".handoff", "context-map.md"));

  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Current understanding:");
  assertIncludes(res.stdout, "Project: fixture-app");
});

test("save: low-verbosity saves keep hashes consistent and tamper detection intact", async () => {
  const dir = await initTempRepo();
  runSave(dir);
  runSave(dir, ["--verbosity", "low"]);

  // Every stored hash still matches the on-disk file after a low save.
  const handoff = join(dir, ".handoff");
  const json = JSON.parse(await readFile(join(handoff, "context.json"), "utf-8"));
  for (const [name, hash] of Object.entries(json.hashes)) {
    const content = await readFile(join(handoff, name), "utf-8");
    assertEqual(hash, sha256Hex(content), `low save dropped the ${name} hash entry`);
  }

  // Tampering with the generated view still warns on load (and on the next save).
  const viewPath = join(handoff, "views", "HANDOFF.md");
  await writeFile(viewPath, (await readFile(viewPath, "utf-8")) + "\n- manual injected task\n");
  const loadRes = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(loadRes.status, 0, `load failed: ${loadRes.stderr}`);
  assertIncludes(loadRes.stderr, "HANDOFF.md");
  const saveRes = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs"), "--verbosity", "low"], { cwd: dir, encoding: "utf-8" });
  assertEqual(saveRes.status, 0, `save failed: ${saveRes.stderr}`);
  assertIncludes(saveRes.stderr, "HANDOFF.md");
});

// ── Legacy migration (v2) ─────────────────────────────────────────────────

async function copyHandoffFixture(name) {
  const dir = await mkdtemp(join(tmpdir(), `handoff-migrate-${name}-`));
  await cp(join(fixturesDir, "handoffs", name), dir, { recursive: true });
  return dir;
}

test("migrate: save migrates a legacy 1.x handoff to v3 with backup and stays idempotent", async () => {
  const dir = await copyHandoffFixture("legacy-1x");
  const out = runSave(dir);
  assertIncludes(out, "migrat", "save should announce the migration");

  const handoff = join(dir, ".handoff");
  const map = parseContextMapV3(await readFile(join(handoff, "context-map.md"), "utf-8"));
  assert(map, "migration did not produce a readable v3 context map");
  assertEqual(map.sections.goals[0].label, "feat: add rate limiting middleware");
  assert(map.sections.tasks.every((n) => !n.checked), "legacy tasks should stay pending");
  assert(map.sections.tasks.every((n) => n.id && n.id.startsWith("task")), "legacy tasks lost their stable IDs");
  const tasksMd = await readFile(join(handoff, "content", "tasks.md"), "utf-8");
  assertIncludes(tasksMd, "Add Redis backend for distributed rate limiting", "legacy task body lost");
  const decisionsMd = await readFile(join(handoff, "content", "decisions.md"), "utf-8");
  assertIncludes(decisionsMd, "Simpler to reason about bursty traffic", "decision rationale lost");
  const risksMd = await readFile(join(handoff, "content", "risks.md"), "utf-8");
  assertIncludes(risksMd, "1 high-priority TODO/FIXME items pending", "legacy risk lost");

  // Legacy root views are retired; originals are backed up.
  for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    assert(!existsSync(join(handoff, legacy)), `legacy root file '${legacy}' must be retired`);
  }
  const migrationsRoot = join(handoff, "history", "migrations");
  assertEqual((await readdir(migrationsRoot)).length, 1, "expected exactly one backup directory");
  const backupDir = join(migrationsRoot, (await readdir(migrationsRoot))[0]);
  assertIncludes(await readFile(join(backupDir, "HANDOFF.md"), "utf-8"), "v1.2.0", "backup must hold the original HANDOFF.md");
  assertIncludes(await readFile(join(backupDir, "context.json"), "utf-8"), "my-api", "backup must hold the original context.json");
  assert(existsSync(join(backupDir, ".handoff.config.json")), "config not backed up");

  // Versions upgrade to v3.
  const config = JSON.parse(await readFile(join(dir, ".handoff.config.json"), "utf-8"));
  assertEqual(config.version, V3_PROTOCOL_VERSION, "config version not upgraded");
  const json = JSON.parse(await readFile(join(handoff, "context.json"), "utf-8"));
  assertEqual(json.protocolVersion, V3_PROTOCOL_VERSION, "context.json version not upgraded");
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

  const handoff = join(dir, ".handoff");
  const map = parseContextMapV3(await readFile(join(handoff, "context-map.md"), "utf-8"));
  assertEqual(map.sections.goals.length, 1, "singleton goal duplicated");
  assertEqual(map.sections.goals[0].label, "Ship the map-approved compiler release", "map goal must win");

  const questions = map.sections.questions;
  assert(questions.some((n) => n.label === "How should v3 rank branches"), "map question lost");
  const conflictParent = questions.find((n) => n.label === "Migration conflict");
  assert(conflictParent, "Migration conflict node missing from Open Questions");
  const children = questions.filter((n) => n.depth > 0);
  assertEqual(children.length, 4, `every conflict child must become its own node: ${JSON.stringify(children.map((n) => n.label))}`);
  const questionsMd = await readFile(join(handoff, "content", "open-questions.md"), "utf-8");
  assertIncludes(questionsMd, "JSON draft goal superseded by the map (source: context.json)");
  assertIncludes(questionsMd, "HANDOFF view goal superseded by the map (source: HANDOFF.md)");

  assertEqual(map.sections.excluded[0].label, "No vector database in v3", "exclusion lost");
  const tasks = map.sections.tasks;
  const shared = tasks.filter((n) => n.label.includes("Wire the context compiler into load"));
  assertEqual(shared.length, 1, "overlapping task not deduplicated");
  assertEqual(shared[0].checked, false, "map task state lost to the legacy duplicate");
  const tasksMd = await readFile(join(handoff, "content", "tasks.md"), "utf-8");
  assertIncludes(tasksMd, "Legacy-only task from context.json", "unique context.json task lost");
  assertIncludes(tasksMd, "Legacy-only task from HANDOFF.md", "unique HANDOFF.md task lost");
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

test("load: a v2 handoff warns that the next save migrates to v3 (read-only)", () => {
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], {
    cwd: join(fixturesDir, "handoffs", "migrated"),
    encoding: "utf-8",
  });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stderr, "migrat", "v2 handoff should trigger a v3 migration note");
  assertIncludes(res.stdout, "Already migrated v2 goal", "v2 load behavior changed");
});

test("load: a v3 handoff does not warn about migration", () => {
  const res = spawnSync(process.execPath, [join(root, "scripts", "node", "load.mjs")], {
    cwd: join(fixturesDir, "v3", "basic"),
    encoding: "utf-8",
  });
  assertEqual(res.status, 0, `load failed: ${res.stderr}`);
  assertNotIncludes(res.stderr, "migrat", "v3 handoff must not trigger a migration note");
  assertIncludes(res.stdout, "Ship the v3 context directory release");
  assertIncludes(res.stdout, "Pending tasks: 1");
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

test("load --focus: a present-but-empty value is rejected like a missing one", () => {
  for (const args of [["--focus"], ["--focus", ""]]) {
    const res = runLoadArgs(join(fixturesDir, "handoffs", "map-only"), args);
    assertEqual(res.status, 1, `args ${JSON.stringify(args)} must exit 1: ${res.stdout}${res.stderr}`);
    assertIncludes(res.stderr, "--focus requires a value");
  }
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
