// @ts-nocheck
/**
 * Handoff Protocol v2.2 — Obsidian adapter Deno integration tests.
 *
 * Mirrors the Node adapter suite (tests/node/adapter.test.mjs) against
 * scripts/adapter.ts, keeping both runtimes equivalent.
 *
 * Run: deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
 */

import { assert, assertEqual, assertIncludes, assertNotIncludes } from "../shared/unit-suite.mjs";

const root = new URL("../../", import.meta.url);
const adapterCli = new URL("scripts/adapter.ts", root).pathname;
const deno = Deno.execPath();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runAdapter(cwd, args, env = {}) {
  const out = await new Deno.Command(deno, {
    args: ["run", "--allow-read", "--allow-write", "--allow-env", adapterCli, ...args],
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function makeProject(name) {
  const dir = await Deno.makeTempDir({ prefix: `handoff-adapter-deno-${name}-` });
  await Deno.mkdir(`${dir}/.handoff`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.handoff/context-map.md`, "# Context Map\n");
  await Deno.writeTextFile(
    `${dir}/.handoff.config.json`,
    JSON.stringify({ version: "2.2.0", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  return dir;
}

// Spaces and Unicode in the Vault path must work end to end.
async function makeVault() {
  return await Deno.makeTempDir({ prefix: "handoff-vault 知识库 " });
}

async function makeXdg() {
  return await Deno.makeTempDir({ prefix: "handoff-xdg-deno-" });
}

async function pathExists(path) {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test("adapter: link creates <Vault>/Projects/<alias> pointing at .handoff/", async () => {
  const project = await makeProject("link");
  const vault = await makeVault();
  const xdg = await makeXdg();

  const r = await runAdapter(project, ["obsidian", "link", "--vault", vault, "--alias", "my proj"], {
    XDG_CONFIG_HOME: xdg,
  });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);
  assertIncludes(r.stdout, "Linked");

  const linkPath = `${vault}/Projects/my proj`;
  const st = await Deno.lstat(linkPath);
  assert(st.isSymlink, "link path must be a symlink");
  assertEqual(await Deno.readLink(linkPath), `${await Deno.realPath(project)}/.handoff`, "link must point at .handoff/");
});

Deno.test("adapter: link stores the Vault path only in user-level config, never in project config", async () => {
  const project = await makeProject("cfg");
  const vault = await makeVault();
  const xdg = await makeXdg();

  const r = await runAdapter(project, ["obsidian", "link", "--vault", vault, "--alias", "my proj"], {
    XDG_CONFIG_HOME: xdg,
  });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const userConfig = JSON.parse(await Deno.readTextFile(`${xdg}/handoff/config.json`));
  assertEqual(userConfig.adapters.obsidian.vaultPath, vault, "Vault path must land in user config");

  const projectConfig = JSON.parse(await Deno.readTextFile(`${project}/.handoff.config.json`));
  assertEqual(projectConfig.adapters.obsidian.enabled, true);
  assertEqual(projectConfig.adapters.obsidian.projectAlias, "my proj");
  assertNotIncludes(JSON.stringify(projectConfig), vault, "project config must never contain the Vault path");
});

Deno.test("adapter: link is idempotent and status reports the link", async () => {
  const project = await makeProject("idem");
  const vault = await makeVault();
  const xdg = await makeXdg();

  const first = await runAdapter(project, ["obsidian", "link", "--vault", vault], { XDG_CONFIG_HOME: xdg });
  assertEqual(first.code, 0, `first link failed: ${first.stderr}`);
  const second = await runAdapter(project, ["obsidian", "link", "--vault", vault], { XDG_CONFIG_HOME: xdg });
  assertEqual(second.code, 0, `second link must succeed: ${second.stderr}`);
  assertIncludes(second.stdout + second.stderr, "Already");

  const status = await runAdapter(project, ["obsidian", "status"], { XDG_CONFIG_HOME: xdg });
  assertEqual(status.code, 0, `status failed: ${status.stderr}`);
  assertIncludes(status.stdout, "linked");
  assertIncludes(status.stdout, vault);
});

Deno.test("adapter: link refuses to replace a real directory", async () => {
  const project = await makeProject("collide");
  const vault = await makeVault();
  const xdg = await makeXdg();
  const alias = project.split("/").pop();
  await Deno.mkdir(`${vault}/Projects/${alias}`, { recursive: true });
  await Deno.writeTextFile(`${vault}/Projects/${alias}/user-note.md`, "user data\n");

  const r = await runAdapter(project, ["obsidian", "link", "--vault", vault], { XDG_CONFIG_HOME: xdg });
  assert(r.code !== 0, "link must fail on a real directory");
  assert(await pathExists(`${vault}/Projects/${alias}/user-note.md`), "user data must remain untouched");
});

Deno.test("adapter: unlink removes only the link and never its target", async () => {
  const project = await makeProject("unlink");
  const vault = await makeVault();
  const xdg = await makeXdg();
  const alias = project.split("/").pop();

  const linked = await runAdapter(project, ["obsidian", "link", "--vault", vault], { XDG_CONFIG_HOME: xdg });
  assertEqual(linked.code, 0, `link failed: ${linked.stderr}`);
  const r = await runAdapter(project, ["obsidian", "unlink"], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `unlink failed: ${r.stderr}`);

  assert(!(await pathExists(`${vault}/Projects/${alias}`)), "link must be gone");
  assert(await pathExists(`${project}/.handoff/context-map.md`), ".handoff target must remain");

  const status = await runAdapter(project, ["obsidian", "status"], { XDG_CONFIG_HOME: xdg });
  assertEqual(status.code, 0);
  assertIncludes(status.stdout, "missing");
});

Deno.test("adapter: unlink refuses a real directory without touching it", async () => {
  const project = await makeProject("unlink-dir");
  const vault = await makeVault();
  const xdg = await makeXdg();
  const alias = project.split("/").pop();
  await Deno.mkdir(`${vault}/Projects/${alias}`, { recursive: true });
  await Deno.writeTextFile(`${vault}/Projects/${alias}/user-note.md`, "user data\n");
  await Deno.mkdir(`${xdg}/handoff`, { recursive: true });
  await Deno.writeTextFile(
    `${xdg}/handoff/config.json`,
    JSON.stringify({ adapters: { obsidian: { vaultPath: vault } } }, null, 2)
  );

  const r = await runAdapter(project, ["obsidian", "unlink"], { XDG_CONFIG_HOME: xdg });
  assert(r.code !== 0, "unlink must refuse a real directory");
  assert(await pathExists(`${vault}/Projects/${alias}/user-note.md`), "user data must remain untouched");
});

Deno.test("adapter: status without a configured Vault gives actionable output", async () => {
  const project = await makeProject("novault");
  const xdg = await makeXdg();
  const r = await runAdapter(project, ["obsidian", "status"], { XDG_CONFIG_HOME: xdg });
  assert(r.code !== 0, "status without a Vault must fail");
  assertIncludes(r.stderr + r.stdout, "link --vault", "output should point at the link command");
});
