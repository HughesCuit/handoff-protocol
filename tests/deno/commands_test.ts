// @ts-nocheck
/**
 * Handoff Protocol — CLI command behavior tests (Deno).
 *
 * Mirrors tests/node/commands.test.mjs: executable coverage for `init`,
 * `storage`, and the `auto`/`merge` load modes. Save modes and verbosity,
 * compiler flags, the Obsidian adapter, and `diff` are covered in
 * context_map_test.ts, adapter_test.ts, and diff_test.ts.
 *
 * Run: deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
 */

import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
} from "../shared/unit-suite.mjs";
import { PROTOCOL_VERSION, parseContextMapV3 } from "../../scripts/context-map.mjs";

const fixturesDir = new URL("../fixtures/", import.meta.url);
const root = new URL("../../", import.meta.url);

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

function runSave(cwd, args = []) {
  return run(
    deno,
    ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", new URL("scripts/save.ts", root).pathname, ...args],
    cwd
  );
}

function runLoad(cwd, mode = "default") {
  return run(deno, ["run", "--allow-read", "--allow-run", new URL("scripts/load.ts", root).pathname, mode], cwd);
}

async function git(cwd, args) {
  const res = await run("git", args, cwd);
  assertEqual(res.code, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function initTempRepo() {
  const dir = await Deno.makeTempDir({ prefix: "handoff-cmd-deno-" });
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify({ name: "fixture-app" }) + "\n");
  await Deno.writeTextFile(`${dir}/.gitignore`, ".handoff/\n");
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "1.5.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "feat: initial commit"]);
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

// ── /handoff init ────────────────────────────────────────────────────────────

Deno.test("init: direct mode creates .handoff/ and a portable config without prompting", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-init-deno-" });
  const res = await runSave(dir, ["init", "direct"]);
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Initialized direct storage mode");
  assert(await pathExists(`${dir}/.handoff`), ".handoff/ was not created");

  const raw = await Deno.readTextFile(`${dir}/.handoff.config.json`);
  const config = JSON.parse(raw);
  assertEqual(config.version, PROTOCOL_VERSION);
  assertEqual(config.storage.mode, "direct");
  assertEqual(config.storage.path, ".handoff");
  assertNotIncludes(raw, dir, "config must not embed machine-specific absolute paths");
});

// ── /handoff storage ─────────────────────────────────────────────────────────

Deno.test("storage: displays the current mode and path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-storage-deno-" });
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: PROTOCOL_VERSION, storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  const res = await runSave(dir, ["storage"]);
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Handoff storage:");
  assertIncludes(res.stdout, "mode: direct");
  assertIncludes(res.stdout, "path: .handoff");
});

Deno.test("storage: reports unconfigured state when no config exists", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-storage-none-deno-" });
  const res = await runSave(dir, ["storage"]);
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Handoff storage is not configured.");
  assertIncludes(res.stdout, "/handoff init");
});

// ── /handoff load auto ───────────────────────────────────────────────────────

Deno.test("load auto: appends the auto-analysis block", async () => {
  const res = await runLoad(new URL("handoffs/map-only", fixturesDir).pathname, "auto");
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Current understanding:");
  assertIncludes(res.stdout, "Auto-analysis:");
  assertIncludes(res.stdout, "Last saved:");
  assertIncludes(res.stdout, "Modified files:");
  assertIncludes(res.stdout, "Branch:");
});

// ── /handoff load merge ──────────────────────────────────────────────────────

Deno.test("load merge: surfaces commits made since the handoff", async () => {
  const dir = await initTempRepo();
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  await Deno.writeTextFile(`${dir}/feature.ts`, "export const feature = true;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "feat: advance the work"]);

  res = await runLoad(dir, "merge");
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "Current understanding:");
  assertIncludes(res.stdout, "Sync with 1 new commit(s) since handoff");
});

// ── v3 save behavior ─────────────────────────────────────────────────────────

Deno.test("save: user-edited labels and bodies survive subsequent saves", async () => {
  const dir = await initTempRepo();
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  const mapPath = `${dir}/.handoff/context-map.md`;
  const notesPath = `${dir}/.handoff/content/knowledge-notes.md`;
  const map = await Deno.readTextFile(mapPath);
  const noteLine = map.match(/- `note1`[^\n]*/);
  assert(noteLine, "expected an inferred note node to edit");
  await Deno.writeTextFile(mapPath, map.replace(noteLine[0], "- `note1` User refined knowledge label"));
  await Deno.writeTextFile(notesPath, "# Knowledge and Notes\n\n## note1\n\nUser refined body.\n");

  res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const after = parseContextMapV3(await Deno.readTextFile(mapPath));
  const note = after.sections.notes.find((n) => n.id === "note1");
  assert(note, "user-edited node lost its ID");
  assertEqual(note.label, "User refined knowledge label", "user label was overwritten by inference");
  assertIncludes(await Deno.readTextFile(notesPath), "User refined body.", "user body was overwritten by inference");
});

Deno.test("save: task completion and node deletion survive the next save", async () => {
  const dir = await initTempRepo();
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(`${dir}/src/app.ts`, "// TODO: keep this task around\n");
  let res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);

  const mapPath = `${dir}/.handoff/context-map.md`;
  const map = await Deno.readTextFile(mapPath);
  const checked = map.replace("- [ ] `task1`", "- [x] `task1`");
  assert(checked !== map, "expected a task1 node to complete");
  await Deno.writeTextFile(mapPath, checked.replace("## Decisions", "## Decisions\n\n- `decision1` Temporary human decision"));

  res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const after = parseContextMapV3(await Deno.readTextFile(mapPath));
  const task = after.sections.tasks.find((n) => n.id === "task1");
  assert(task, "task1 missing after completion");
  assertEqual(task.checked, true, "user task completion was not preserved");

  // Delete the decision node; its body stays behind as a reported orphan.
  await Deno.writeTextFile(`${dir}/.handoff/content/decisions.md`, "# Decisions\n\n## decision1\n\nTemporary decision body.\n");
  const beforeDelete = await Deno.readTextFile(mapPath);
  await Deno.writeTextFile(mapPath, beforeDelete.replace("\n- `decision1` Temporary human decision\n", "\n"));
  res = await runSave(dir);
  assertEqual(res.code, 0, `save failed: ${res.stderr}`);
  const final = parseContextMapV3(await Deno.readTextFile(mapPath));
  assert(!final.sections.decisions.some((n) => n.id === "decision1"), "a deleted node was recreated from its leftover body");
  assertIncludes(res.stderr, "CONTENT_ORPHAN", "the leftover body must be reported as an orphan");
  assertIncludes(await Deno.readTextFile(`${dir}/.handoff/content/decisions.md`), "decision1", "orphan body must be retained, not deleted");
});

Deno.test("save: a release commit never becomes the Current Goal", async () => {
  const dir = await initTempRepo();
  await Deno.writeTextFile(`${dir}/release.ts`, "export const release = true;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "release: prepare 3.0.0"]);

  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  const map = parseContextMapV3(await Deno.readTextFile(`${dir}/.handoff/context-map.md`));
  assertEqual(map.sections.goals.length, 0, "a release commit became the Current Goal");
});

Deno.test("save: a v2 handoff migrates automatically on the first save", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-v2mig-deno-" });
  const cp = await run("cp", ["-r", new URL("migration/v2-complete", fixturesDir).pathname + "/.", dir], dir);
  assertEqual(cp.code, 0, `fixture copy failed: ${cp.stderr}`);
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "2.0.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );

  const res = await runSave(dir);
  assertEqual(res.code, 0, res.stderr);
  assertIncludes(res.stdout, "migrated to Handoff Protocol v3.0.0", "save should announce the v3 migration");
  assertIncludes(res.stdout, "Backup:", "migration backup not reported");

  const map = parseContextMapV3(await Deno.readTextFile(`${dir}/.handoff/context-map.md`));
  assert(map, "migration did not produce a readable v3 map");
  assertEqual(map.sections.goals[0].label, "Ship the context directory release");
  assertEqual(map.sections.tasks.length, 3);
  for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    let exists = true;
    try {
      await Deno.stat(`${dir}/.handoff/${legacy}`);
    } catch {
      exists = false;
    }
    assert(!exists, `legacy root file '${legacy}' must be retired`);
  }
  const config = JSON.parse(await Deno.readTextFile(`${dir}/.handoff.config.json`));
  assertEqual(config.version, "3.0.0", "config version not upgraded");
});
