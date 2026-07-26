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
import { readFile, mkdtemp, writeFile, mkdir } from "node:fs/promises";
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
import { parseContextMap, SECTION_LABELS, SECTION_KEYS } from "../../scripts/context-map.mjs";

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
  const ctx = JSON.parse(await readFile(join(dir, ".handoff", "context.json"), "utf-8"));
  const tasks = ctx.todos.map((t) => t.task).join("\n");
  assertIncludes(tasks, "wire up the real scanner (src/app.ts:1)");
  assertNotIncludes(tasks, "string false positive");
  assertNotIncludes(tasks, "template false positive");
  assertNotIncludes(tasks, "fixture dir must be excluded");
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
