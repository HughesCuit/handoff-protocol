/**
 * Handoff Protocol v2.3 — Context diff Node.js integration tests.
 *
 * Exercises scripts/node/diff.mjs against real temp projects seeded from the
 * shared fixtures (tests/fixtures/diff/), covering every change class, both
 * output formats, invalid snapshot ids, malformed snapshots, and the
 * read-only contract (diff never mutates snapshots or the Context Map).
 *
 * Run: node --test "tests/node/diff.test.mjs"
 */

import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { assert, assertEqual, assertIncludes, assertNotIncludes } from "../shared/unit-suite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const diffCli = join(root, "scripts", "node", "diff.mjs");
const fixtureDir = join(root, "tests", "fixtures", "diff");

const SNAPSHOT_ID = "2026-07-28T00-00-00-000Z-c17b1135";

function runDiff(cwd, args = []) {
  const out = spawnSync(process.execPath, [diffCli, ...args], { cwd, encoding: "utf-8" });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

async function makeProject({ snapshotBody, withSnapshot = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-diff-"));
  const snapDir = join(dir, ".handoff", "history", "snapshots");
  await mkdir(snapDir, { recursive: true });
  await writeFile(join(dir, ".handoff", "context-map.md"), await readFile(join(fixtureDir, "context-map.md"), "utf-8"));
  if (withSnapshot) {
    const body = snapshotBody ?? (await readFile(join(fixtureDir, "before-snapshot.json"), "utf-8"));
    await writeFile(join(snapDir, `${SNAPSHOT_ID}.json`), body);
  }
  return dir;
}

async function projectFingerprint(dir) {
  const snapDir = join(dir, ".handoff", "history", "snapshots");
  const names = (await readdir(snapDir)).sort();
  const bodies = [];
  for (const name of names) bodies.push(await readFile(join(snapDir, name), "utf-8"));
  return JSON.stringify([names, bodies, await readFile(join(dir, ".handoff", "context-map.md"), "utf-8")]);
}

test("diff: default markdown output reports every change class", async () => {
  const project = await makeProject();
  const r = runDiff(project);
  assertEqual(r.code, 0, `diff failed: ${r.stderr}`);

  assertIncludes(r.stdout, "Context diff");
  assertIncludes(r.stdout, SNAPSHOT_ID);
  assertIncludes(r.stdout, "Added");
  assertIncludes(r.stdout, "Removed");
  assertIncludes(r.stdout, "Edited");
  assertIncludes(r.stdout, "Moved");
  assertIncludes(r.stdout, "Task state changed");

  // Edited: status text rewritten in place.
  assertIncludes(r.stdout, "Diff core sketched");
  assertIncludes(r.stdout, "CLI wiring in progress");
  // Removed: a decision and a knowledge note vanished.
  assertIncludes(r.stdout, "Compare rendered markdown line by line");
  assertIncludes(r.stdout, "Old note to drop");
  // Added: a new risk appeared.
  assertIncludes(r.stdout, "CLI must never mutate snapshots");
  // Task state: "Update user docs" flipped back to open.
  assertIncludes(r.stdout, "Update user docs");
});

test("diff: --format json emits stable arrays with section/path/before/after", async () => {
  const project = await makeProject();
  const r = runDiff(project, ["--format", "json"]);
  assertEqual(r.code, 0, `diff failed: ${r.stderr}`);

  const json = JSON.parse(r.stdout);
  assertEqual(json.snapshot.id, SNAPSHOT_ID);
  for (const key of ["added", "removed", "edited", "moved", "taskStateChanged"]) {
    assert(Array.isArray(json[key]), `json.${key} must be an array`);
  }

  assertEqual(json.edited.length, 1);
  assertEqual(json.edited[0].section, "status");
  assertEqual(json.edited[0].path, "Diff core sketched");
  assertEqual(json.edited[0].before, "Diff core sketched");
  assertEqual(json.edited[0].after, "Diff core implemented, CLI wiring in progress");

  assertEqual(json.removed.length, 2);
  assertEqual(json.removed[0].section, "decisions");
  assertEqual(json.removed[0].before, "Compare rendered markdown line by line");
  assertEqual(json.removed[1].section, "knowledge");

  assertEqual(json.added.length, 1);
  assertEqual(json.added[0].section, "risks");
  assertEqual(json.added[0].after, "CLI must never mutate snapshots");

  assertEqual(json.taskStateChanged.length, 1);
  assertEqual(json.taskStateChanged[0].section, "tasks");
  assertEqual(json.taskStateChanged[0].path, "Update user docs");
  assertEqual(json.taskStateChanged[0].task.before, true);
  assertEqual(json.taskStateChanged[0].task.after, false);
});

test("diff: --from <snapshot-id> and --from latest both resolve", async () => {
  const project = await makeProject();
  for (const from of [SNAPSHOT_ID, "latest"]) {
    const r = runDiff(project, ["--from", from, "--format", "json"]);
    assertEqual(r.code, 0, `diff --from ${from} failed: ${r.stderr}`);
    assertEqual(JSON.parse(r.stdout).snapshot.id, SNAPSHOT_ID);
  }
});

test("diff: unknown and malformed snapshot ids fail with actionable errors", async () => {
  const project = await makeProject();

  const unknown = runDiff(project, ["--from", "1999-01-01T00-00-00-000Z-deadbeef"]);
  assert(unknown.code !== 0, "unknown snapshot id must fail");
  assertIncludes(unknown.stderr + unknown.stdout, "1999-01-01T00-00-00-000Z-deadbeef");

  const invalid = runDiff(project, ["--from", "../../etc/passwd"]);
  assert(invalid.code !== 0, "malformed snapshot id must fail");
  assertIncludes(invalid.stderr + invalid.stdout, "invalid");

  const badFormat = runDiff(project, ["--format", "yaml"]);
  assert(badFormat.code !== 0, "unknown format must fail");
});

test("diff: no snapshots and malformed snapshot files fail cleanly", async () => {
  const empty = await makeProject({ withSnapshot: false });
  const none = runDiff(empty);
  assert(none.code !== 0, "no snapshots must fail");
  assertIncludes(none.stderr + none.stdout, "snapshot");

  const broken = await makeProject({ snapshotBody: "{ not json" });
  const malformed = runDiff(broken);
  assert(malformed.code !== 0, "malformed snapshot must fail");
  assertIncludes(malformed.stderr + malformed.stdout, "malformed");
});

test("diff: reads but never mutates snapshots or the current state", async () => {
  const project = await makeProject();
  const before = await projectFingerprint(project);
  assertEqual(runDiff(project).code, 0);
  assertEqual(runDiff(project, ["--format", "json"]).code, 0);
  assertEqual(await projectFingerprint(project), before, "diff mutated on-disk state");
});

test("diff: output is sensitive-filtered before display", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-diff-secret-"));
  const snapDir = join(dir, ".handoff", "history", "snapshots");
  await mkdir(snapDir, { recursive: true });
  const secret = "api_key=abcdefghijklmnop123456";
  await writeFile(join(dir, ".handoff", "context-map.md"), `# Context Map\n\n## Knowledge\n\n- rotated ${secret}\n`);
  const snapshot = JSON.parse(await readFile(join(fixtureDir, "before-snapshot.json"), "utf-8"));
  snapshot.state = {
    sections: Object.fromEntries([
      "goal", "status", "tasks", "decisions", "questions", "risks", "knowledge", "excluded",
    ].map((k) => [k, []])),
    extras: [],
  };
  snapshot.state.sections.knowledge = [{ text: `old ${secret}`, depth: 0, origin: "user" }];
  await writeFile(join(snapDir, `${SNAPSHOT_ID}.json`), JSON.stringify(snapshot, null, 2));

  for (const args of [[], ["--format", "json"]]) {
    const r = runDiff(dir, args);
    assertEqual(r.code, 0, `diff failed: ${r.stderr}`);
    assertNotIncludes(r.stdout, "abcdefghijklmnop123456", "raw secret reached diff output");
    assertIncludes(r.stdout, "[REDACTED]");
  }
});

test("diff: a flag-like token is never bound as a flag value", async () => {
  const project = await makeProject();

  const misroute = runDiff(project, ["--from", "--format", "json"]);
  assertEqual(misroute.code, 1, "flag-like value must be rejected");
  assertIncludes(misroute.stderr, "--from requires a value");

  const trailing = runDiff(project, ["--from"]);
  assertEqual(trailing.code, 1, "trailing --from with no value must be rejected");
  assertIncludes(trailing.stderr, "--from requires a value");
});

// ── v3 stable-ID diff ────────────────────────────────────────────────────────

test("diff: a v3 layout reports stable-ID change categories and stays read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-diff-v3-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "diff-v3" }) + "\n");
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: "2.0.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.ts"), "// TODO: wire the v3 diff\n");

  const save = spawnSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
  assertEqual(save.status, 0, `save failed: ${save.stderr}`);

  const mapPath = join(dir, ".handoff", "context-map.md");
  const tasksPath = join(dir, ".handoff", "content", "tasks.md");
  const snapDir = join(dir, ".handoff", "history", "snapshots");
  const snapBefore = await readdir(snapDir);
  assertEqual(snapBefore.length, 1, "save should record one v3 snapshot");
  const snapshotBody = await readFile(join(snapDir, snapBefore[0]), "utf-8");

  // Unsaved edits: complete task1 and edit its summary.
  await writeFile(mapPath, (await readFile(mapPath, "utf-8")).replace("- [ ] `task1`", "- [x] `task1`"));
  await writeFile(tasksPath, (await readFile(tasksPath, "utf-8")).replace("wire the v3 diff", "wire the v3 diff (edited)"));

  const md = runDiff(dir);
  assertEqual(md.code, 0, `diff failed: ${md.stderr}`);
  assertIncludes(md.stdout, "Task state changed");
  assertIncludes(md.stdout, "Summary edited");
  assertIncludes(md.stdout, "task1");

  const json = runDiff(dir, ["--format", "json"]);
  assertEqual(json.code, 0, `diff failed: ${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  for (const key of ["added", "deleted", "moved", "labelEdited", "summaryEdited", "bodyEdited", "taskStateChanged", "attributesChanged"]) {
    assert(Array.isArray(parsed[key]), `json.${key} must be an array`);
  }
  assertEqual(parsed.taskStateChanged.length, 1);
  assertEqual(parsed.taskStateChanged[0].id, "task1");
  assertEqual(parsed.summaryEdited.length, 1);

  // Read-only: the snapshot is untouched and no new snapshot appeared.
  assertEqual((await readdir(snapDir)).length, 1, "diff wrote a snapshot");
  assertEqual(await readFile(join(snapDir, snapBefore[0]), "utf-8"), snapshotBody, "diff mutated the snapshot");
});
