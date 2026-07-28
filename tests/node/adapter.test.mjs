/**
 * Handoff Protocol v2.2 — Obsidian adapter Node.js integration tests.
 *
 * Exercises scripts/node/adapter.mjs against real temp directories, including
 * Vault paths with spaces and Unicode, the user-level config location
 * ($XDG_CONFIG_HOME), idempotent links, collisions, and safe unlink.
 *
 * Run: node --test "tests/node/adapter.test.mjs"
 */

import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, realpath, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { assert, assertEqual, assertIncludes, assertNotIncludes } from "../shared/unit-suite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const adapterCli = join(root, "scripts", "node", "adapter.mjs");

// ── Helpers ──────────────────────────────────────────────────────────────────

function runAdapter(cwd, args, env = {}) {
  const out = spawnSync(process.execPath, [adapterCli, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

async function makeProject(name) {
  const dir = await mkdtemp(join(tmpdir(), `handoff-adapter-${name}-`));
  await mkdir(join(dir, ".handoff"), { recursive: true });
  await writeFile(join(dir, ".handoff", "context-map.md"), "# Context Map\n");
  await writeFile(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: "2.2.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  return dir;
}

async function makeVault() {
  // Spaces and Unicode in the Vault path must work end to end.
  const dir = await mkdtemp(join(tmpdir(), "handoff-vault 知识库 "));
  return dir;
}

function withXdg(env = {}) {
  return mkdtemp(join(tmpdir(), "handoff-xdg-")).then((xdg) => ({ ...env, XDG_CONFIG_HOME: xdg, _xdg: xdg }));
}

async function readProjectConfig(dir) {
  return JSON.parse(await readFile(join(dir, ".handoff.config.json"), "utf-8"));
}

// ── link ─────────────────────────────────────────────────────────────────────

test("adapter: link creates <Vault>/Projects/<alias> pointing at .handoff/", async () => {
  const project = await makeProject("link");
  const vault = await makeVault();
  const env = await withXdg();

  const r = runAdapter(project, ["obsidian", "link", "--vault", vault, "--alias", "my proj"], env);
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);
  assertIncludes(r.stdout, "Linked");

  const linkPath = join(vault, "Projects", "my proj");
  const st = await lstat(linkPath);
  assert(st.isSymbolicLink(), "link path must be a symlink");
  assertEqual(await readlink(linkPath), join(await realpath(project), ".handoff"), "link must point at .handoff/");
});

test("adapter: link stores the Vault path only in user-level config, never in project config", async () => {
  const project = await makeProject("cfg");
  const vault = await makeVault();
  const env = await withXdg();

  const r = runAdapter(project, ["obsidian", "link", "--vault", vault, "--alias", "my proj"], env);
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const userConfig = JSON.parse(await readFile(join(env._xdg, "handoff", "config.json"), "utf-8"));
  assertEqual(userConfig.adapters.obsidian.vaultPath, vault, "Vault path must land in user config");

  const projectConfig = await readProjectConfig(project);
  assertEqual(projectConfig.adapters.obsidian.enabled, true, "project config must record enabled");
  assertEqual(projectConfig.adapters.obsidian.projectAlias, "my proj", "project config must record the alias");
  assertNotIncludes(
    JSON.stringify(projectConfig),
    vault,
    "project config must never contain the Vault absolute path"
  );
});

test("adapter: link is idempotent and status reports the link", async () => {
  const project = await makeProject("idem");
  const vault = await makeVault();
  const env = await withXdg();

  const first = runAdapter(project, ["obsidian", "link", "--vault", vault], env);
  assertEqual(first.code, 0, `first link failed: ${first.stderr}`);
  const second = runAdapter(project, ["obsidian", "link", "--vault", vault], env);
  assertEqual(second.code, 0, `second link must succeed: ${second.stderr}`);
  assertIncludes(second.stdout + second.stderr, "Already");

  const status = runAdapter(project, ["obsidian", "status"], env);
  assertEqual(status.code, 0, `status failed: ${status.stderr}`);
  assertIncludes(status.stdout, "linked");
  assertIncludes(status.stdout, vault, "status should show the Vault path");
});

test("adapter: link refuses to replace a real directory", async () => {
  const project = await makeProject("collide");
  const vault = await makeVault();
  const env = await withXdg();
  const alias = project.split("/").pop();
  await mkdir(join(vault, "Projects", alias), { recursive: true });
  await writeFile(join(vault, "Projects", alias, "user-note.md"), "user data\n");

  const r = runAdapter(project, ["obsidian", "link", "--vault", vault], env);
  assert(r.code !== 0, "link must fail on a real directory");
  assertIncludes(r.stderr + r.stdout, "Refusing");
  assert(existsSync(join(vault, "Projects", alias, "user-note.md")), "user data must remain untouched");
});

test("adapter: link refuses a foreign link pointing at another project", async () => {
  const project = await makeProject("foreign");
  const vault = await makeVault();
  const env = await withXdg();
  const alias = project.split("/").pop();
  await mkdir(join(vault, "Projects"), { recursive: true });
  await symlink("/somewhere/else", join(vault, "Projects", alias), "dir");

  const r = runAdapter(project, ["obsidian", "link", "--vault", vault], env);
  assert(r.code !== 0, "link must fail on a foreign link");
  assertEqual(await readlink(join(vault, "Projects", alias)), "/somewhere/else", "foreign link must remain");
});

test("adapter: link rejects a relative Vault path", async () => {
  const project = await makeProject("relvault");
  const env = await withXdg();
  const r = runAdapter(project, ["obsidian", "link", "--vault", "relative/Vault"], env);
  assert(r.code !== 0, "relative Vault path must be rejected");
  assertIncludes(r.stderr + r.stdout, "Vault");
});

// ── unlink ───────────────────────────────────────────────────────────────────

test("adapter: unlink removes only the link and never its target", async () => {
  const project = await makeProject("unlink");
  const vault = await makeVault();
  const env = await withXdg();
  const alias = project.split("/").pop();

  assertEqual(runAdapter(project, ["obsidian", "link", "--vault", vault], env).code, 0);
  const r = runAdapter(project, ["obsidian", "unlink"], env);
  assertEqual(r.code, 0, `unlink failed: ${r.stderr}`);

  assert(!existsSync(join(vault, "Projects", alias)), "link must be gone");
  assert(existsSync(join(project, ".handoff", "context-map.md")), ".handoff target must remain");

  const status = runAdapter(project, ["obsidian", "status"], env);
  assertEqual(status.code, 0);
  assertIncludes(status.stdout, "missing");
});

test("adapter: unlink refuses a real directory without touching it", async () => {
  const project = await makeProject("unlink-dir");
  const vault = await makeVault();
  const env = await withXdg();
  const alias = project.split("/").pop();
  await mkdir(join(vault, "Projects", alias), { recursive: true });
  await writeFile(join(vault, "Projects", alias, "user-note.md"), "user data\n");
  // Pretend the Vault was linked before: seed the user config.
  await mkdir(join(env._xdg, "handoff"), { recursive: true });
  await writeFile(
    join(env._xdg, "handoff", "config.json"),
    JSON.stringify({ adapters: { obsidian: { vaultPath: vault } } }, null, 2)
  );

  const r = runAdapter(project, ["obsidian", "unlink"], env);
  assert(r.code !== 0, "unlink must refuse a real directory");
  assert(existsSync(join(vault, "Projects", alias, "user-note.md")), "user data must remain untouched");
});

test("adapter: status without a configured Vault gives actionable output", async () => {
  const project = await makeProject("novault");
  const env = await withXdg();
  const r = runAdapter(project, ["obsidian", "status"], env);
  assert(r.code !== 0, "status without a Vault must fail");
  assertIncludes(r.stderr + r.stdout, "link --vault", "output should point at the link command");
});
