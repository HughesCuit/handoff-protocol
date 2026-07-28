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

// ── Vault index helpers ─────────────────────────────────────────────────────

const INDEX_FILENAME = "Handoff Projects.md";
const seedFixture = new URL("tests/fixtures/adapters/vault-index-seed.md", root).pathname;

async function readIndex(vault) {
  return await Deno.readTextFile(`${vault}/${INDEX_FILENAME}`);
}

async function seedIndex(vault, content) {
  await Deno.writeTextFile(`${vault}/${INDEX_FILENAME}`, content ?? (await Deno.readTextFile(seedFixture)));
}

async function listFilesRecursive(dir) {
  const out = [];
  for await (const entry of Deno.readDir(dir)) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
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

// ── Vault index ──────────────────────────────────────────────────────────────

Deno.test("adapter: link maintains a sorted wikilink index in Handoff Projects.md", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();

  const zeta = await makeProject("idx-zeta");
  const lz = await runAdapter(zeta, ["obsidian", "link", "--vault", vault, "--alias", "zeta"], { XDG_CONFIG_HOME: xdg });
  assertEqual(lz.code, 0, `link failed: ${lz.stderr}`);
  const alpha = await makeProject("idx-alpha");
  const la = await runAdapter(alpha, ["obsidian", "link", "--vault", vault, "--alias", "alpha"], { XDG_CONFIG_HOME: xdg });
  assertEqual(la.code, 0, `link failed: ${la.stderr}`);

  const index = await readIndex(vault);
  assertIncludes(index, "<!-- handoff-projects:start -->");
  assertIncludes(index, "<!-- handoff-projects:end -->");
  assertIncludes(index, "- [[Projects/alpha/context-map]]");
  assertIncludes(index, "- [[Projects/zeta/context-map]]");
  assert(
    index.indexOf("[[Projects/alpha/context-map]]") < index.indexOf("[[Projects/zeta/context-map]]"),
    "entries must be sorted"
  );
});

Deno.test("adapter: user content outside the managed block survives link", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();
  await seedIndex(vault);

  const alpha = await makeProject("keep-link");
  const r = await runAdapter(alpha, ["obsidian", "link", "--vault", vault, "--alias", "alpha"], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const index = await readIndex(vault);
  assertIncludes(index, "User notes above the managed block.");
  assertIncludes(index, "User notes below the managed block.");
  assertIncludes(index, "# My Vault");
  assertIncludes(index, "- [[Projects/zeta/context-map]]", "pre-existing entry must survive");
  assertIncludes(index, "- [[Projects/alpha/context-map]]", "new entry must be added");
  assert(
    index.indexOf("[[Projects/alpha/context-map]]") < index.indexOf("[[Projects/zeta/context-map]]"),
    "entries must be re-sorted"
  );
});

Deno.test("adapter: unlink removes only the matching entry and preserves user content", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();
  await seedIndex(vault); // contains a zeta entry

  const alpha = await makeProject("unl-alpha");
  const la = await runAdapter(alpha, ["obsidian", "link", "--vault", vault, "--alias", "alpha"], { XDG_CONFIG_HOME: xdg });
  assertEqual(la.code, 0, `link failed: ${la.stderr}`);
  const beta = await makeProject("unl-beta");
  const lb = await runAdapter(beta, ["obsidian", "link", "--vault", vault, "--alias", "beta"], { XDG_CONFIG_HOME: xdg });
  assertEqual(lb.code, 0, `link failed: ${lb.stderr}`);

  const r = await runAdapter(beta, ["obsidian", "unlink"], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `unlink failed: ${r.stderr}`);

  const index = await readIndex(vault);
  assertNotIncludes(index, "[[Projects/beta/context-map]]", "unlinked entry must be removed");
  assertIncludes(index, "- [[Projects/alpha/context-map]]", "other entries must remain");
  assertIncludes(index, "- [[Projects/zeta/context-map]]", "seeded entry must remain");
  assertIncludes(index, "User notes above the managed block.");
  assertIncludes(index, "User notes below the managed block.");
});

Deno.test("adapter: sensitive data is filtered before writing the index", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();
  const alias = "AKIAIOSFODNN7EXAMPLE"; // matches the AWS-access-key sensitive pattern

  const project = await makeProject("secret");
  // A credential-like alias is (correctly) refused in the portable project
  // config; drop it so the link itself can proceed to the index write.
  await Deno.remove(`${project}/.handoff.config.json`);
  const r = await runAdapter(project, ["obsidian", "link", "--vault", vault, "--alias", alias], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const index = await readIndex(vault);
  assertNotIncludes(index, alias, "raw credential-like alias must never reach the index");
  assertIncludes(index, "[REDACTED]");
});

Deno.test("adapter: no Canvas or Dataview files are generated", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();

  const project = await makeProject("nocanvas");
  const r = await runAdapter(project, ["obsidian", "link", "--vault", vault], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const files = await listFilesRecursive(vault);
  for (const file of files) {
    assert(!file.endsWith(".canvas"), `no Canvas file may be generated: ${file}`);
    assert(!file.toLowerCase().includes("dataview"), `no Dataview artifact may be generated: ${file}`);
  }
  const rootEntries = [];
  for await (const entry of Deno.readDir(vault)) rootEntries.push(entry.name);
  rootEntries.sort();
  assertEqual(rootEntries.join(","), [INDEX_FILENAME, "Projects"].sort().join(","), "vault root must only hold the index note and Projects/");
});

Deno.test("adapter: CRLF line endings in an existing index are preserved", async () => {
  const vault = await makeVault();
  const xdg = await makeXdg();
  const crlf = (await Deno.readTextFile(seedFixture)).replace(/\n/g, "\r\n");
  await seedIndex(vault, crlf);

  const alpha = await makeProject("crlf");
  const r = await runAdapter(alpha, ["obsidian", "link", "--vault", vault, "--alias", "alpha"], { XDG_CONFIG_HOME: xdg });
  assertEqual(r.code, 0, `link failed: ${r.stderr}`);

  const index = await readIndex(vault);
  assert(index.includes("\r\n"), "CRLF line endings must be preserved");
  assert(!/(?<!\r)\n/.test(index), "no lone LF may be introduced");
  assertIncludes(index, "- [[Projects/alpha/context-map]]");
});

Deno.test("adapter: a flag-like token is never bound as a flag value", async () => {
  const project = await makeProject("flag-value");
  const xdg = await Deno.makeTempDir({ prefix: "handoff-xdg-" });
  const env = { XDG_CONFIG_HOME: xdg };

  const misroute = await runAdapter(project, ["obsidian", "link", "--vault", "--alias", "x"], env);
  assertEqual(misroute.code, 1, "flag-like value must be rejected");
  assertIncludes(misroute.stderr, "--vault requires a value");

  const trailing = await runAdapter(project, ["obsidian", "link", "--vault"], env);
  assertEqual(trailing.code, 1, "trailing --vault with no value must be rejected");
  assertIncludes(trailing.stderr, "--vault requires a value");
});
