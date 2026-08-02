// @ts-nocheck
/**
 * Handoff Protocol v2.3 — Context diff Deno integration tests.
 *
 * Mirrors the Node diff suite (tests/node/diff.test.mjs) against
 * scripts/diff.ts, keeping both runtimes equivalent.
 *
 * Run: deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
 */

import { assert, assertEqual, assertIncludes, assertNotIncludes } from "../shared/unit-suite.mjs";

const root = new URL("../../", import.meta.url);
const diffCli = new URL("scripts/diff.ts", root).pathname;
const fixtureDir = new URL("tests/fixtures/diff/", root).pathname;
const deno = Deno.execPath();

const SNAPSHOT_ID = "2026-07-28T00-00-00-000Z-c17b1135";

async function runDiff(cwd, args = []) {
  const out = await new Deno.Command(deno, {
    args: ["run", "--allow-read", "--allow-env", diffCli, ...args],
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

async function makeProject({ snapshotBody, withSnapshot = true } = {}) {
  const dir = await Deno.makeTempDir({ prefix: "handoff-diff-deno-" });
  const snapDir = `${dir}/.handoff/history/snapshots`;
  await Deno.mkdir(snapDir, { recursive: true });
  await Deno.writeTextFile(`${dir}/.handoff/context-map.md`, await Deno.readTextFile(`${fixtureDir}/context-map.md`));
  if (withSnapshot) {
    const body = snapshotBody ?? (await Deno.readTextFile(`${fixtureDir}/before-snapshot.json`));
    await Deno.writeTextFile(`${snapDir}/${SNAPSHOT_ID}.json`, body);
  }
  return dir;
}

async function projectFingerprint(dir) {
  const snapDir = `${dir}/.handoff/history/snapshots`;
  const names = [];
  for await (const entry of Deno.readDir(snapDir)) names.push(entry.name);
  names.sort();
  const bodies = [];
  for (const name of names) bodies.push(await Deno.readTextFile(`${snapDir}/${name}`));
  return JSON.stringify([names, bodies, await Deno.readTextFile(`${dir}/.handoff/context-map.md`)]);
}

Deno.test("diff: default markdown output reports every change class", async () => {
  const project = await makeProject();
  const r = await runDiff(project);
  assertEqual(r.code, 0, `diff failed: ${r.stderr}`);

  assertIncludes(r.stdout, "Context diff");
  assertIncludes(r.stdout, SNAPSHOT_ID);
  assertIncludes(r.stdout, "Added");
  assertIncludes(r.stdout, "Removed");
  assertIncludes(r.stdout, "Edited");
  assertIncludes(r.stdout, "Moved");
  assertIncludes(r.stdout, "Task state changed");

  assertIncludes(r.stdout, "Diff core sketched");
  assertIncludes(r.stdout, "CLI wiring in progress");
  assertIncludes(r.stdout, "Compare rendered markdown line by line");
  assertIncludes(r.stdout, "Old note to drop");
  assertIncludes(r.stdout, "CLI must never mutate snapshots");
  assertIncludes(r.stdout, "Update user docs");
});

Deno.test("diff: --format json emits stable arrays with section/path/before/after", async () => {
  const project = await makeProject();
  const r = await runDiff(project, ["--format", "json"]);
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

Deno.test("diff: --from <snapshot-id> and --from latest both resolve", async () => {
  const project = await makeProject();
  for (const from of [SNAPSHOT_ID, "latest"]) {
    const r = await runDiff(project, ["--from", from, "--format", "json"]);
    assertEqual(r.code, 0, `diff --from ${from} failed: ${r.stderr}`);
    assertEqual(JSON.parse(r.stdout).snapshot.id, SNAPSHOT_ID);
  }
});

Deno.test("diff: unknown and malformed snapshot ids fail with actionable errors", async () => {
  const project = await makeProject();

  const unknown = await runDiff(project, ["--from", "1999-01-01T00-00-00-000Z-deadbeef"]);
  assert(unknown.code !== 0, "unknown snapshot id must fail");
  assertIncludes(unknown.stderr + unknown.stdout, "1999-01-01T00-00-00-000Z-deadbeef");

  const invalid = await runDiff(project, ["--from", "../../etc/passwd"]);
  assert(invalid.code !== 0, "malformed snapshot id must fail");
  assertIncludes(invalid.stderr + invalid.stdout, "invalid");

  const badFormat = await runDiff(project, ["--format", "yaml"]);
  assert(badFormat.code !== 0, "unknown format must fail");
});

Deno.test("diff: no snapshots and malformed snapshot files fail cleanly", async () => {
  const empty = await makeProject({ withSnapshot: false });
  const none = await runDiff(empty);
  assert(none.code !== 0, "no snapshots must fail");
  assertIncludes(none.stderr + none.stdout, "snapshot");

  const broken = await makeProject({ snapshotBody: "{ not json" });
  const malformed = await runDiff(broken);
  assert(malformed.code !== 0, "malformed snapshot must fail");
  assertIncludes(malformed.stderr + malformed.stdout, "malformed");
});

Deno.test("diff: reads but never mutates snapshots or the current state", async () => {
  const project = await makeProject();
  const before = await projectFingerprint(project);
  assertEqual((await runDiff(project)).code, 0);
  assertEqual((await runDiff(project, ["--format", "json"])).code, 0);
  assertEqual(await projectFingerprint(project), before, "diff mutated on-disk state");
});

Deno.test("diff: output is sensitive-filtered before display", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-diff-secret-deno-" });
  const snapDir = `${dir}/.handoff/history/snapshots`;
  await Deno.mkdir(snapDir, { recursive: true });
  const secret = "api_key=abcdefghijklmnop123456";
  await Deno.writeTextFile(`${dir}/.handoff/context-map.md`, `# Context Map\n\n## Knowledge\n\n- rotated ${secret}\n`);
  const snapshot = JSON.parse(await Deno.readTextFile(`${fixtureDir}/before-snapshot.json`));
  snapshot.state = {
    sections: Object.fromEntries([
      "goal", "status", "tasks", "decisions", "questions", "risks", "knowledge", "excluded",
    ].map((k) => [k, []])),
    extras: [],
  };
  snapshot.state.sections.knowledge = [{ text: `old ${secret}`, depth: 0, origin: "user" }];
  await Deno.writeTextFile(`${snapDir}/${SNAPSHOT_ID}.json`, JSON.stringify(snapshot, null, 2));

  for (const args of [[], ["--format", "json"]]) {
    const r = await runDiff(dir, args);
    assertEqual(r.code, 0, `diff failed: ${r.stderr}`);
    assertNotIncludes(r.stdout, "abcdefghijklmnop123456", "raw secret reached diff output");
    assertIncludes(r.stdout, "[REDACTED]");
  }
});

Deno.test("diff: a flag-like token is never bound as a flag value", async () => {
  const project = await makeProject();

  const misroute = await runDiff(project, ["--from", "--format", "json"]);
  assertEqual(misroute.code, 1, "flag-like value must be rejected");
  assertIncludes(misroute.stderr, "--from requires a value");

  const trailing = await runDiff(project, ["--from"]);
  assertEqual(trailing.code, 1, "trailing --from with no value must be rejected");
  assertIncludes(trailing.stderr, "--from requires a value");
});

// ── v3 stable-ID diff ────────────────────────────────────────────────────────

Deno.test("diff: a v3 layout reports stable-ID change categories and stays read-only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "handoff-diff-v3-deno-" });
  await Deno.writeTextFile(`${dir}/package.json`, JSON.stringify({ name: "diff-v3" }) + "\n");
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "2.0.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(`${dir}/src/app.ts`, "// TODO: wire the v3 diff\n");

  const saveOut = await new Deno.Command(deno, {
    args: ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", new URL("scripts/save.ts", root).pathname],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const save = { code: saveOut.code, stderr: new TextDecoder().decode(saveOut.stderr) };
  assertEqual(save.code, 0, `save failed: ${save.stderr}`);

  const mapPath = `${dir}/.handoff/context-map.md`;
  const tasksPath = `${dir}/.handoff/content/tasks.md`;
  const snapDir = `${dir}/.handoff/history/snapshots`;
  const snapNames = async () => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(snapDir)) names.push(entry.name);
    return names;
  };
  const before = await snapNames();
  assertEqual(before.length, 1, "save should record one v3 snapshot");
  const snapshotBody = await Deno.readTextFile(`${snapDir}/${before[0]}`);

  // Unsaved edits: complete task1 and edit its summary.
  await Deno.writeTextFile(mapPath, (await Deno.readTextFile(mapPath)).replace("- [ ] `task1`", "- [x] `task1`"));
  await Deno.writeTextFile(tasksPath, (await Deno.readTextFile(tasksPath)).replace("wire the v3 diff", "wire the v3 diff (edited)"));

  const md = await runDiff(dir);
  assertEqual(md.code, 0, `diff failed: ${md.stderr}`);
  assertIncludes(md.stdout, "Task state changed");
  assertIncludes(md.stdout, "Summary edited");
  assertIncludes(md.stdout, "task1");

  const json = await runDiff(dir, ["--format", "json"]);
  assertEqual(json.code, 0, `diff failed: ${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  for (const key of ["added", "deleted", "moved", "labelEdited", "summaryEdited", "bodyEdited", "taskStateChanged", "attributesChanged"]) {
    assert(Array.isArray(parsed[key]), `json.${key} must be an array`);
  }
  assertEqual(parsed.taskStateChanged.length, 1);
  assertEqual(parsed.taskStateChanged[0].id, "task1");
  assertEqual(parsed.summaryEdited.length, 1);

  // Read-only: the snapshot is untouched and no new snapshot appeared.
  assertEqual((await snapNames()).length, 1, "diff wrote a snapshot");
  assertEqual(await Deno.readTextFile(`${snapDir}/${before[0]}`), snapshotBody, "diff mutated the snapshot");
});
