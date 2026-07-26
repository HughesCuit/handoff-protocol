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
import { parseContextMap, SECTION_LABELS, SECTION_KEYS } from "../../scripts/context-map.mjs";
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
