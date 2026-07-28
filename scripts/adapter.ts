#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// @ts-nocheck

/**
 * Handoff Protocol - Adapter Command (Deno Implementation)
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env adapter.ts obsidian link --vault <path> [--alias <name>]
 *   deno run --allow-read --allow-write --allow-env adapter.ts obsidian status
 *   deno run --allow-read --allow-write --allow-env adapter.ts obsidian unlink
 *
 * Behavior is identical to scripts/node/adapter.mjs; all adapter logic lives
 * in the shared, runtime-agnostic core (scripts/adapters/obsidian.mjs).
 */

import { filterSensitive } from "./context-map.mjs";
import { CONFIG_FILENAME, validateProjectConfig } from "./config.mjs";
import {
  obsidianLink,
  obsidianStatus,
  obsidianUnlink,
  resolveAlias,
  userConfigPath,
} from "./adapters/obsidian.mjs";

// ── Filesystem adapter for the shared core ───────────────────────────────────

const io = {
  lstat: async (p) => {
    try {
      const st = await Deno.lstat(p);
      if (st.isSymlink) return { kind: "symlink" };
      if (st.isDirectory) return { kind: "directory" };
      if (st.isFile) return { kind: "file" };
      return { kind: "other" };
    } catch {
      return null;
    }
  },
  exists: async (p) => {
    try {
      await Deno.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  readlink: (p) => Deno.readLink(p),
  symlink: async (target, linkPath, opts) => {
    await Deno.symlink(target, linkPath, { type: opts && opts.junction ? "junction" : "dir" });
  },
  mkdir: (p) => Deno.mkdir(p, { recursive: true }),
  unlink: (p) => Deno.remove(p),
  readFile: async (p) => {
    try {
      return await Deno.readTextFile(p);
    } catch {
      return null;
    }
  },
  writeFile: (p, content) => Deno.writeTextFile(p, content),
};

// ── Config helpers ───────────────────────────────────────────────────────────

function joinPath(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}

function readProjectConfig(cwd) {
  let content;
  try {
    content = Deno.readTextFileSync(joinPath(cwd, CONFIG_FILENAME));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    console.error(`Error: could not read ${CONFIG_FILENAME}: ${err.message}`);
    Deno.exit(1);
  }
  try {
    const config = JSON.parse(content);
    const result = validateProjectConfig(config);
    if (!result.valid) {
      console.error("Error: invalid .handoff.config.json:");
      for (const err of result.errors) console.error(`  - ${err}`);
      Deno.exit(1);
    }
    return result.config;
  } catch (err) {
    console.error(`Error: could not parse ${CONFIG_FILENAME}: ${err.message}`);
    Deno.exit(1);
  }
}

function envMap() {
  const env = {};
  for (const key of ["XDG_CONFIG_HOME", "HOME", "APPDATA", "USERPROFILE"]) {
    const value = Deno.env.get(key);
    if (value) env[key] = value;
  }
  return env;
}

const platform = Deno.build.os === "windows" ? "win32" : Deno.build.os;

function userConfigFile() {
  const path = userConfigPath(envMap(), platform);
  if (!path) {
    console.error("Error: could not resolve a user-level config location (HOME, XDG_CONFIG_HOME, or APPDATA is unset).");
    Deno.exit(1);
  }
  return path;
}

function readUserConfig() {
  try {
    const config = JSON.parse(Deno.readTextFileSync(userConfigFile()));
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

// The user-level config holds machine-specific state (the Vault path). It is
// local-only, but the sensitive-data filter still runs before persistence.
function writeUserConfig(config) {
  const path = userConfigFile();
  const dir = path.split(/[\\/]/).slice(0, -1).join(path.includes("\\") ? "\\" : "/");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(path, filterSensitive(JSON.stringify(config, null, 2)) + "\n");
}

function vaultPathFromUserConfig() {
  return readUserConfig()?.adapters?.obsidian?.vaultPath || null;
}

function recordVaultPath(vaultPath) {
  const config = readUserConfig();
  config.adapters = config.adapters && typeof config.adapters === "object" ? config.adapters : {};
  config.adapters.obsidian = { ...(config.adapters.obsidian || {}), vaultPath };
  writeUserConfig(config);
}

// Persist portable adapter state (enabled + alias) into the project config
// when one exists. The Vault path is never written here.
function recordProjectAdapter(cwd, projectConfig, alias) {
  if (!projectConfig) return;
  const next = {
    ...projectConfig,
    adapters: {
      ...(projectConfig.adapters || {}),
      obsidian: { ...(projectConfig.adapters?.obsidian || {}), enabled: true, projectAlias: alias },
    },
  };
  const result = validateProjectConfig(next);
  if (!result.valid) {
    console.error("Error: refusing to write non-portable .handoff.config.json:");
    for (const err of result.errors) console.error(`  - ${err}`);
    Deno.exit(1);
  }
  Deno.writeTextFileSync(joinPath(cwd, CONFIG_FILENAME), JSON.stringify(result.config, null, 2) + "\n");
}

// ── Output ───────────────────────────────────────────────────────────────────

function printResult(result) {
  if (!result.ok) {
    console.error(`Error: ${result.message}`);
    if (result.guidance) console.error(result.guidance);
    return;
  }
  switch (result.state) {
    case "linked":
      console.log(`Linked ${result.linkPath} -> ${result.target}`);
      break;
    case "already-linked":
      console.log(`Already linked: ${result.linkPath} -> ${result.target}`);
      break;
    case "unlinked":
      console.log(`Unlinked ${result.linkPath}`);
      break;
    case "not-linked":
      console.log(`No adapter link exists at ${result.linkPath}`);
      break;
    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

async function printStatus(vaultPath, alias, cwd) {
  const status = await obsidianStatus({ vaultPath, alias, projectDir: cwd, platform }, io);
  console.log("Obsidian adapter:");
  console.log(`  vault: ${vaultPath}`);
  console.log(`  alias: ${alias}`);
  console.log(`  link: ${status.linkPath}`);
  console.log(`  target: ${status.target}`);
  console.log(`  state: ${status.state}`);
  if (status.actualTarget && status.state !== "linked") console.log(`  actual target: ${status.actualTarget}`);
  return status;
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const rawArgs = Deno.args;
const namedArgs = {};
const positionalArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--vault" || rawArgs[i] === "--alias") {
    const value = rawArgs[i + 1];
    // A missing value or a following flag must not be bound as the value or
    // fall into the positional parse (parity with load.mjs).
    if (value === undefined || value.startsWith("--")) {
      console.error(`Error: ${rawArgs[i]} requires a value`);
      Deno.exit(1);
    }
    namedArgs[rawArgs[i].slice(2)] = value;
    i++;
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

const [adapterName, action] = positionalArgs;
const USAGE = `Usage:
  adapter.ts obsidian link --vault <path> [--alias <name>]
  adapter.ts obsidian status
  adapter.ts obsidian unlink`;

async function main() {
  if (adapterName !== "obsidian" || !["link", "status", "unlink"].includes(action || "")) {
    console.error(USAGE);
    Deno.exit(1);
  }

  const cwd = Deno.cwd();
  const projectConfig = readProjectConfig(cwd);
  const alias = resolveAlias({
    alias: namedArgs.alias,
    projectAlias: projectConfig?.adapters?.obsidian?.projectAlias,
    projectDir: cwd,
  });

  if (action === "link") {
    if (!namedArgs.vault) {
      console.error("Error: link requires --vault <path>.");
      console.error(USAGE);
      Deno.exit(1);
    }
    const result = await obsidianLink(
      { vaultPath: namedArgs.vault, alias, projectDir: cwd, platform },
      io
    );
    printResult(result);
    if (!result.ok) Deno.exit(1);
    recordVaultPath(namedArgs.vault);
    recordProjectAdapter(cwd, projectConfig, alias);
    return;
  }

  // status / unlink resolve the Vault path from the user-level config.
  const vaultPath = vaultPathFromUserConfig();
  if (!vaultPath) {
    console.error("Error: no Obsidian Vault is configured for this user.");
    console.error("Run `/handoff adapter obsidian link --vault <path>` first.");
    Deno.exit(1);
  }

  if (action === "status") {
    await printStatus(vaultPath, alias, cwd);
    return;
  }

  const result = await obsidianUnlink({ vaultPath, alias, projectDir: cwd, platform }, io);
  printResult(result);
  if (!result.ok) Deno.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  Deno.exit(1);
});
