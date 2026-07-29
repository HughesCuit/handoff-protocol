// @ts-nocheck
/**
 * Handoff Protocol v1.5 — Deno test suite.
 *
 * Runs the shared unit suite (identical to the Node suite) plus Deno-specific
 * integration tests that exercise scripts/save.ts and load.ts against the
 * shared fixtures.
 *
 * Run: deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
 */

import {
  defineUnitTests,
  assert,
  assertEqual,
  assertIncludes,
} from "../shared/unit-suite.mjs";
import { parseContextMap, PROTOCOL_VERSION, SECTION_LABELS, SECTION_KEYS } from "../../scripts/context-map.mjs";
import { GENERATED_MARKER, sha256Hex } from "../../scripts/views.mjs";

const fixturesDir = new URL("../fixtures/", import.meta.url);
const root = new URL("../../", import.meta.url);
const readFixture = (rel) => Deno.readTextFile(new URL(rel, fixturesDir));

defineUnitTests((name, fn) => Deno.test(name, fn), readFixture);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function run(cmd, args, cwd) {
  const out = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

const deno = Deno.execPath();

function runLoad(cwd, mode = "default") {
  return run(deno, ["run", "--allow-read", "--allow-run", new URL("scripts/load.ts", root).pathname, mode], cwd);
}

function runSave(cwd, args = []) {
  return run(
    deno,
    ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", new URL("scripts/save.ts", root).pathname, ...args],
    cwd
  );
}

async function initTempRepo() {
  const dir = await Deno.makeTempDir({ prefix: "handoff-save-deno-" });
  await run("git", ["init", "-q"], dir);
  await run("git", ["config", "user.email", "test@example.com"], dir);
  await run("git", ["config", "user.name", "Test"], dir);
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify({ name: "fixture-app" }) + "\n");
  await Deno.writeTextFile(`${dir}/.gitignore`, ".handoff/\n");
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  await run("git", ["add", "."], dir);
  await run("git", ["commit", "-q", "-m", "feat: initial commit"], dir);
  return dir;
}

async function pathExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function understandingOf(out) {
  const m = out.match(/Current understanding:\n([\s\S]*?)\n\n/);
  return m ? m[1].trim() : "";
}

const fixturePath = (rel) => new URL(`handoffs/${rel}`, fixturesDir).pathname;

// ── Load integration ─────────────────────────────────────────────────────────

Deno.test("load: legacy 1.x four-file handoff (no map) still loads", async () => {
  const res = await runLoad(fixturePath("legacy-1x"));
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "feat: add rate limiting middleware");
  assertIncludes(res.stdout, "Pending tasks: 3");
  assertIncludes(res.stdout, "Branch: feature/rate-limiting");
});

Deno.test("load: map-only handoff loads successfully", async () => {
  const res = await runLoad(fixturePath("map-only"));
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Ship the v1.5 context map release");
  assertIncludes(res.stdout, "Pending tasks: 1");
});

Deno.test("load: mixed handoff prefers map semantics, supplements machine state", async () => {
  const res = await runLoad(fixturePath("mixed"));
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Selective context compilation for v3");
  assert(!understandingOf(res.stdout).includes("Legacy JSON goal"), "map goal should win over JSON goal");
  assertIncludes(res.stdout, "Branch: feature/map");
  assertIncludes(res.stdout, "Pending tasks: 1");
});

// ── Save integration ─────────────────────────────────────────────────────────

Deno.test("save: generates context-map.md with all sections, reconciles idempotently", async () => {
  const dir = await initTempRepo();

  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const mapPath = `${dir}/.handoff/context-map.md`;
  assert(await pathExists(mapPath), "context-map.md was not written");
  const first = await Deno.readTextFile(mapPath);
  for (const key of SECTION_KEYS) {
    assertIncludes(first, `## ${SECTION_LABELS[key].en}`, `missing section '${key}'`);
  }
  for (const f of ["HANDOFF.md", "context.json", "tasks.md", "decisions.md"]) {
    assert(await pathExists(`${dir}/.handoff/${f}`), `${f} missing after save`);
  }

  res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const second = await Deno.readTextFile(mapPath);
  assertEqual(second, first, "repeated save was not idempotent");
});

Deno.test("save: snapshots semantic state only when it changes", async () => {
  const dir = await initTempRepo();
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const snapDir = `${dir}/.handoff/history/snapshots`;
  const names = async (): Promise<string[]> => {
    const out: string[] = [];
    for await (const entry of Deno.readDir(snapDir)) out.push(entry.name);
    return out;
  };

  assertEqual((await names()).length, 1, "first save should write one snapshot");

  res = await runSave(dir); // unchanged
  assertEqual(res.code, 0, res.stderr);
  assertEqual((await names()).length, 1, "unchanged save must not snapshot");

  // A user edit to the map changes semantic state.
  const mapPath = `${dir}/.handoff/context-map.md`;
  const map = await Deno.readTextFile(mapPath);
  await Deno.writeTextFile(
    mapPath,
    map.replace("## Knowledge and Notes", "## Knowledge and Notes\n\n- User note from a human edit")
  );
  res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  assertEqual((await names()).length, 2, "changed save should write a second snapshot");
});

Deno.test("save: low verbosity still writes the context map (and skips legacy task files)", async () => {
  const dir = await initTempRepo();
  const res = await runSave(dir, ["--verbosity", "low"]);
  assertEqual(res.code, 0, res.stderr);

  const mapPath = `${dir}/.handoff/context-map.md`;
  assert(await pathExists(mapPath), "low verbosity save did not write context-map.md");
  const map = await Deno.readTextFile(mapPath);
  assertIncludes(map, "## Current Goal");
  assertIncludes(map, "## Excluded");
  assert(
    (await Deno.readTextFile(`${dir}/.handoff/HANDOFF.md`)).startsWith(GENERATED_MARKER),
    "low verbosity HANDOFF.md is not a marked generated view"
  );
  assert(!(await pathExists(`${dir}/.handoff/tasks.md`)), "low verbosity should skip tasks.md");
  assert(!(await pathExists(`${dir}/.handoff/decisions.md`)), "low verbosity should skip decisions.md");
});

for (const [label, args] of [
  ["compact mode", ["compact"]],
  ["full mode", ["full"]],
  ["diff mode", ["diff"]],
  ["high verbosity", ["--verbosity", "high"]],
]) {
  Deno.test(`save: ${label} writes a readable context map`, async () => {
    const dir = await initTempRepo();
    const res = await runSave(dir, args);
    assertEqual(res.code, 0, res.stderr);
    const mapPath = `${dir}/.handoff/context-map.md`;
    assert(await pathExists(mapPath), `${label} did not write context-map.md`);
    const parsed = parseContextMap(await Deno.readTextFile(mapPath));
    assert(parsed, `${label} wrote an unreadable context map`);
    for (const key of SECTION_KEYS) {
      assert(Array.isArray(parsed.sections[key]), `${label} omitted section '${key}'`);
    }
    // Compatibility views are still produced at every mode/verbosity.
    for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
      assert(await pathExists(`${dir}/.handoff/${name}`), `${label} did not write ${name}`);
      assert(
        (await Deno.readTextFile(`${dir}/.handoff/${name}`)).startsWith(GENERATED_MARKER),
        `${label} wrote ${name} without the generated marker`
      );
    }
  });
}

Deno.test("save: submodule storage includes context-map.md in the submodule commit", async () => {
  const seed = await Deno.makeTempDir({ prefix: "handoff-seed-" });
  const remote = await Deno.makeTempDir({ prefix: "handoff-remote-" });
  await run("git", ["init", "-q", "--bare"], remote);
  await run("git", ["init", "-q"], seed);
  await run("git", ["config", "user.email", "test@example.com"], seed);
  await run("git", ["config", "user.name", "Test"], seed);
  await Deno.writeTextFile(`${seed}/README.md`, "handoff store\n");
  await run("git", ["add", "."], seed);
  await run("git", ["commit", "-q", "-m", "init"], seed);
  await run("git", ["remote", "add", "origin", remote], seed);
  await run("git", ["push", "-q", "origin", "HEAD:main"], seed);

  const dir = await initTempRepo();
  // The fixture .gitignore ignores .handoff/ (direct-mode convention); git
  // refuses to add a submodule at an ignored path, so un-ignore it here.
  await Deno.writeTextFile(`${dir}/.gitignore`, "\n");
  await run("git", ["-c", "protocol.file.allow=always", "submodule", "-q", "add", remote, ".handoff"], dir);
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify(
      { version: "1.5.0", storage: { mode: "submodule", path: ".handoff", remote } },
      null,
      2
    ) + "\n"
  );

  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  assert(await pathExists(`${dir}/.handoff/context-map.md`), "map not written into submodule");
  const tracked = await run("git", ["ls-files"], `${dir}/.handoff`);
  assertIncludes(tracked.stdout, "context-map.md", "context-map.md not committed in submodule");
  assertIncludes(tracked.stdout, "HANDOFF.md", "legacy files not committed in submodule");
});

Deno.test("save: TODO scan only picks up comment tags and skips excluded directories", async () => {
  const dir = await initTempRepo();
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/src/app.ts`,
    [
      "// TODO: wire up the real scanner",
      'const fake = "FIXME: string false positive";',
      "const tpl = `HACK: template false positive`;",
      "",
    ].join("\n")
  );
  await Deno.mkdir(`${dir}/tests/fixtures`, { recursive: true });
  await Deno.writeTextFile(`${dir}/tests/fixtures/sample.ts`, "// TODO: fixture dir must be excluded\n");

  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const tasksMd = await Deno.readTextFile(`${dir}/.handoff/tasks.md`);
  assertIncludes(tasksMd, "wire up the real scanner (src/app.ts:1)");
  assert(!tasksMd.includes("string false positive"), "string contents were scanned");
  assert(!tasksMd.includes("template false positive"), "template literal contents were scanned");
  assert(!tasksMd.includes("fixture dir must be excluded"), "tests/fixtures was scanned");
});

// ── Canonical state and generated views (v2) ────────────────────────────────

const SEMANTIC_JSON_FIELDS = [
  "current_goal", "status", "completed", "modified_files", "todos",
  "blockers", "decisions", "next_steps", "risks", "notes",
];

Deno.test("save: v2 context.json drops semantic fields and stores SHA-256 view hashes", async () => {
  const dir = await initTempRepo();
  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  const json = JSON.parse(await Deno.readTextFile(`${dir}/.handoff/context.json`));
  for (const field of SEMANTIC_JSON_FIELDS) {
    assert(!(field in json), `semantic field '${field}' must not appear in v2 context.json`);
  }
  assert(json.project && json.timestamp && json.agent && json.git, "metadata missing from context.json");
  assertEqual(JSON.stringify(json.diagnostics), JSON.stringify({ migration: [], conflicts: [] }));

  for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    const content = await Deno.readTextFile(`${dir}/.handoff/${name}`);
    assert(content.startsWith(GENERATED_MARKER), `${name} does not begin with the generated marker`);
    assertEqual(json.views[name], sha256Hex(content), `stored hash does not match written ${name}`);
  }
});

Deno.test("save: manual view edits warn and are never imported into the map", async () => {
  const dir = await initTempRepo();
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  await Deno.writeTextFile(`${dir}/.handoff/HANDOFF.md`, "manual vandalism\n");

  res = await runSave(dir);
  assertEqual(res.code, 0, `save failed: ${res.stderr}`);
  assertIncludes(res.stderr, "HANDOFF.md");

  const view = await Deno.readTextFile(`${dir}/.handoff/HANDOFF.md`);
  assert(!view.includes("manual vandalism"), "manual edit survived regeneration");
  const map = await Deno.readTextFile(`${dir}/.handoff/context-map.md`);
  assert(!map.includes("manual vandalism"), "manual view edit was imported into the map");
});

Deno.test("load: warns when a generated view was manually edited, semantics still come from the map", async () => {
  const dir = await initTempRepo();
  const saveRes = await runSave(dir);
  assertEqual(saveRes.code, 0, saveRes.stderr);
  const tasksPath = `${dir}/.handoff/tasks.md`;
  await Deno.writeTextFile(tasksPath, (await Deno.readTextFile(tasksPath)) + "\n- [ ] manual injected task\n");

  const res = await runLoad(dir);
  assertEqual(res.code, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stderr, "tasks.md");
  assertIncludes(res.stdout, "Current understanding:");
  assert(!res.stdout.includes("manual injected task"), "manual view edit leaked into load output");
});

Deno.test("load: v2 handoff with a missing map falls back to the HANDOFF.md view", async () => {
  const dir = await initTempRepo();
  const saveRes = await runSave(dir);
  assertEqual(saveRes.code, 0, saveRes.stderr);
  await Deno.remove(`${dir}/.handoff/context-map.md`);

  const res = await runLoad(dir);
  assertEqual(res.code, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Current understanding:");
  assertIncludes(res.stdout, "Project: fixture-app");
});

Deno.test("save: low-verbosity saves preserve view hashes and tamper detection for skipped views", async () => {
  const dir = await initTempRepo();
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  res = await runSave(dir, ["--verbosity", "low"]);
  assertEqual(res.code, 0, res.stderr);

  // The skipped views keep their hash entries in context.json.
  const json = JSON.parse(await Deno.readTextFile(`${dir}/.handoff/context.json`));
  for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    const content = await Deno.readTextFile(`${dir}/.handoff/${name}`);
    assertEqual(json.views[name], sha256Hex(content), `low save dropped the ${name} hash entry`);
  }

  // Tampering with a skipped view still warns on load (and on the next save).
  const tasksPath = `${dir}/.handoff/tasks.md`;
  await Deno.writeTextFile(tasksPath, (await Deno.readTextFile(tasksPath)) + "\n- [ ] manual injected task\n");
  const loadRes = await runLoad(dir);
  assertEqual(loadRes.code, 0, `load failed: ${loadRes.stderr}`);
  assertIncludes(loadRes.stderr, "tasks.md");
  res = await runSave(dir, ["--verbosity", "low"]);
  assertEqual(res.code, 0, `save failed: ${res.stderr}`);
  assertIncludes(res.stderr, "tasks.md");
});

// ── Legacy migration (v2) ─────────────────────────────────────────────────

async function copyHandoffFixture(name: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `handoff-migrate-${name}-` });
  const res = await run("cp", ["-r", `${fixturePath(name)}/.`, dir], dir);
  assertEqual(res.code, 0, `fixture copy failed: ${res.stderr}`);
  return dir;
}

async function dirNames(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names;
}

Deno.test("migrate: save migrates a legacy 1.x handoff with backup and stays idempotent", async () => {
  const dir = await copyHandoffFixture("legacy-1x");
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "migrat");

  const map = parseContextMap(await Deno.readTextFile(`${dir}/.handoff/context-map.md`));
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
  const migrationsRoot = `${dir}/.handoff/history/migrations`;
  assertEqual((await dirNames(migrationsRoot)).length, 1, "expected exactly one backup directory");
  const backupDir = `${migrationsRoot}/${(await dirNames(migrationsRoot))[0]}`;
  assertIncludes(await Deno.readTextFile(`${backupDir}/HANDOFF.md`), "v1.2.0", "backup must hold the original HANDOFF.md");
  assertIncludes(await Deno.readTextFile(`${backupDir}/context.json`), "my-api", "backup must hold the original context.json");
  assert(await pathExists(`${backupDir}/.handoff.config.json`), "config not backed up");

  // Versions upgrade to v2.
  const config = JSON.parse(await Deno.readTextFile(`${dir}/.handoff.config.json`));
  assertEqual(config.version, PROTOCOL_VERSION, "config version not upgraded");
  const json = JSON.parse(await Deno.readTextFile(`${dir}/.handoff/context.json`));
  assertEqual(json.version, PROTOCOL_VERSION, "context.json version not upgraded");
  assert(json.diagnostics.migration.length > 0, "migration diagnostics missing from context.json");

  // Repeated save: already migrated, no second backup.
  res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  assertEqual((await dirNames(migrationsRoot)).length, 1, "repeated save created a second migration backup");

  // The migrated handoff loads with its legacy semantics intact.
  const loadRes = await runLoad(dir);
  assertEqual(loadRes.code, 0, loadRes.stderr);
  assertIncludes(loadRes.stdout, "feat: add rate limiting middleware");
  assertIncludes(loadRes.stdout, "Pending tasks: 3");
});

Deno.test("migrate: conflicting handoff keeps map semantics and records labeled conflicts", async () => {
  const dir = await copyHandoffFixture("conflicting");
  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  const map = parseContextMap(await Deno.readTextFile(`${dir}/.handoff/context-map.md`));
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

Deno.test("load: legacy handoffs warn that migration is available (read-only)", async () => {
  const res = await runLoad(fixturePath("legacy-1x"));
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stderr, "migrat");
  assertIncludes(res.stdout, "feat: add rate limiting middleware");
});

Deno.test("load: already-migrated v2 handoff does not warn about migration", async () => {
  const res = await runLoad(fixturePath("migrated"));
  assertEqual(res.code, 0, res.stderr);
  assert(!res.stderr.includes("migrat"), `v2 handoff should not trigger a migration warning: ${res.stderr}`);
  assertIncludes(res.stdout, "Already migrated v2 goal");
});

// ── Config validation integration ────────────────────────────────────────────

Deno.test("save: rejects a non-portable .handoff.config.json before writing", async () => {
  const dir = await initTempRepo();
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.1", storage: { mode: "direct", path: "/Users/alice/.handoff" } }, null, 2) + "\n"
  );
  const res = await runSave(dir);
  assertEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.path");
  assert(!(await pathExists(`${dir}/.handoff/HANDOFF.md`)), "save wrote output despite invalid config");
});

Deno.test("save: rejects a malformed storage mode", async () => {
  const dir = await initTempRepo();
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.1", storage: { mode: "network-drive", path: ".handoff" } }, null, 2) + "\n"
  );
  const res = await runSave(dir);
  assertEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.mode");
});

Deno.test("load: rejects a non-portable .handoff.config.json", async () => {
  const dir = await initTempRepo();
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.1", storage: { mode: "direct", path: "~/handoff-data" } }, null, 2) + "\n"
  );
  const res = await runLoad(dir);
  assertEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assertIncludes(res.stderr, "storage.path");
});

Deno.test("storage: reports an invalid configuration instead of displaying it", async () => {
  const dir = await initTempRepo();
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, token: "ghp_0123456789abcdef0123456789abcdef0123" }, null, 2) + "\n"
  );
  const res = await runSave(dir, ["storage"]);
  assertEqual(res.code, 1, `expected exit 1, got ${res.code}: ${res.stdout}${res.stderr}`);
  assertIncludes(res.stderr, "invalid .handoff.config.json");
  assert(!(res.stderr + res.stdout).includes("ghp_0123456789abcdef0123456789abcdef0123"), "secret value was echoed back");
});

// ── Context compiler flags (v2.1) ────────────────────────────────────────────

function runLoadArgs(cwd: string, args: string[] = []) {
  return run(deno, ["run", "--allow-read", "--allow-run", new URL("scripts/load.ts", root).pathname, ...args], cwd);
}

Deno.test("load --focus: compiles the map and prints deterministic diagnostics", async () => {
  const res = await runLoadArgs(fixturePath("map-only"), ["--focus", "vector database"]);
  assertEqual(res.code, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Focus: vector database");
  assertIncludes(res.stdout, "Budget: 4000 estimated tokens");
  assertIncludes(res.stdout, "Selected: goal[0], status[0], tasks[0], excluded[0]");
  assertIncludes(res.stdout, "Omitted: 5 node(s)");
  assertIncludes(res.stdout, "Estimated tokens:");
  assertIncludes(res.stdout, "Overflow: no");
  assert(!res.stdout.includes("Fallback:"), "unexpected fallback on a reliable match");
  assertIncludes(res.stdout, "Ship the v1.5 context map release");
});

Deno.test("load --focus: no reliable match falls back to the full map with a reason", async () => {
  const res = await runLoadArgs(fixturePath("map-only"), ["--focus", "zebra quokka"]);
  assertEqual(res.code, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Fallback:");
  assertIncludes(res.stdout, "Omitted: 0 node(s)");
});

Deno.test("load --budget: values below 512 or non-numeric are rejected", async () => {
  for (const bad of ["100", "511", "abc"]) {
    const res = await runLoadArgs(fixturePath("map-only"), ["--budget", bad]);
    assertEqual(res.code, 1, `budget '${bad}' must exit 1: ${res.stdout}${res.stderr}`);
    assertIncludes(res.stderr, "budget");
  }
  const ok = await runLoadArgs(fixturePath("map-only"), ["--budget", "512"]);
  assertEqual(ok.code, 0, `budget 512 must be accepted: ${ok.stderr}`);
  assertIncludes(ok.stdout, "Context compiler:");
});

Deno.test("load --full: selects the entire map regardless of focus", async () => {
  const res = await runLoadArgs(fixturePath("map-only"), ["--full", "--focus", "zebra"]);
  assertEqual(res.code, 0, `load failed: ${res.stderr}`);
  assertIncludes(res.stdout, "Context compiler:");
  assertIncludes(res.stdout, "Omitted: 0 node(s)");
  assertIncludes(res.stdout, "Overflow: no");
  assert(!res.stdout.includes("Fallback:"), "--full is not a fallback");
});

Deno.test("load --focus: a present-but-empty value is rejected like a missing one", async () => {
  for (const args of [["--focus"], ["--focus", ""]]) {
    const res = await runLoadArgs(fixturePath("map-only"), args);
    assertEqual(res.code, 1, `args ${JSON.stringify(args)} must exit 1: ${res.stdout}${res.stderr}`);
    assertIncludes(res.stderr, "--focus requires a value");
  }
});

Deno.test("load: without compiler flags the output carries no compiler diagnostics", async () => {
  for (const mode of ["default", "auto", "merge"]) {
    const res = await runLoadArgs(fixturePath("map-only"), [mode]);
    assertEqual(res.code, 0, `load failed: ${res.stderr}`);
    assert(!res.stdout.includes("Context compiler:"), `mode '${mode}' printed compiler diagnostics without flags`);
  }
});

Deno.test("load: unknown flags are rejected", async () => {
  const res = await runLoadArgs(fixturePath("map-only"), ["--bogus"]);
  assertEqual(res.code, 1, `unknown flag must exit 1: ${res.stdout}${res.stderr}`);
});

// ── Cross-runtime parity ─────────────────────────────────────────────────────

async function nodeAvailable() {
  try {
    const res = await run("node", ["--version"], undefined);
    return res.code === 0;
  } catch {
    return false;
  }
}

Deno.test({
  name: "parity: Node and Deno loaders produce equivalent output for shared fixtures",
  ignore: !(await nodeAvailable()),
  async fn() {
    for (const fixture of ["legacy-1x", "map-only", "mixed"]) {
      const cwd = fixturePath(fixture);
      const denoRes = await runLoad(cwd);
      assertEqual(denoRes.code, 0, denoRes.stderr);
      const nodeRes = await run("node", [new URL("scripts/node/load.mjs", root).pathname], cwd);
      assertEqual(nodeRes.code, 0, nodeRes.stderr);
      assertEqual(
        understandingOf(nodeRes.stdout),
        understandingOf(denoRes.stdout),
        `understanding diverged for fixture '${fixture}'`
      );
      const pend = (s) => (s.match(/Pending tasks: (\d+)/) || [])[1] || "0";
      assertEqual(pend(nodeRes.stdout), pend(denoRes.stdout), `pending count diverged for '${fixture}'`);
    }
  },
});
