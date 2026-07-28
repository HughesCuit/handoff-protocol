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
import { PROTOCOL_VERSION } from "../../scripts/context-map.mjs";

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
