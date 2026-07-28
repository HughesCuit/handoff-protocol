#!/usr/bin/env node

/**
 * Handoff Protocol - Adapter Command (Node.js Reference Implementation)
 *
 * Usage:
 *   node adapter.mjs obsidian link --vault <path> [--alias <name>]
 *   node adapter.mjs obsidian status
 *   node adapter.mjs obsidian unlink
 *
 * `link` creates `<Vault>/Projects/<alias>` as a directory symlink
 * (macOS/Linux) or directory junction (Windows) pointing at this project's
 * `.handoff/`. The Vault absolute path is stored only in the user-level
 * config ($XDG_CONFIG_HOME/handoff/config.json, falling back to
 * ~/.config/handoff/config.json on macOS/Linux; %APPDATA%/handoff/config.json
 * on Windows) — never in the portable project config.
 */

import { lstatSync, readlinkSync, symlinkSync, mkdirSync, unlinkSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { filterSensitive } from "../context-map.mjs";
import { CONFIG_FILENAME, validateProjectConfig } from "../config.mjs";
import {
  obsidianLink,
  obsidianStatus,
  obsidianUnlink,
  resolveAlias,
  userConfigPath,
} from "../adapters/obsidian.mjs";

// ── Filesystem adapter for the shared core ───────────────────────────────────

const io = {
  lstat: async (p) => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return { kind: "symlink" };
      if (st.isDirectory()) return { kind: "directory" };
      if (st.isFile()) return { kind: "file" };
      return { kind: "other" };
    } catch {
      return null;
    }
  },
  exists: async (p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  },
  readlink: async (p) => readlinkSync(p),
  symlink: async (target, linkPath, opts) => symlinkSync(target, linkPath, opts && opts.junction ? "junction" : "dir"),
  mkdir: async (p) => mkdirSync(p, { recursive: true }),
  unlink: async (p) => unlinkSync(p),
  readFile: async (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  },
  writeFile: async (p, content) => writeFileSync(p, content),
};

// ── Config helpers ───────────────────────────────────────────────────────────

function readProjectConfig(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf-8"));
    const result = validateProjectConfig(config);
    if (!result.valid) {
      console.error("Error: invalid .handoff.config.json:");
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    return result.config;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    console.error(`Error: could not parse ${CONFIG_FILENAME}: ${err.message}`);
    process.exit(1);
  }
}

function userConfigFile() {
  const path = userConfigPath(process.env, process.platform);
  if (!path) {
    console.error("Error: could not resolve a user-level config location (HOME, XDG_CONFIG_HOME, or APPDATA is unset).");
    process.exit(1);
  }
  return path;
}

function readUserConfig() {
  try {
    const config = JSON.parse(readFileSync(userConfigFile(), "utf-8"));
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

// The user-level config holds machine-specific state (the Vault path). It is
// local-only, but the sensitive-data filter still runs before persistence.
function writeUserConfig(config) {
  const path = userConfigFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, filterSensitive(JSON.stringify(config, null, 2)) + "\n");
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
    process.exit(1);
  }
  writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify(result.config, null, 2) + "\n");
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
  const status = await obsidianStatus({ vaultPath, alias, projectDir: cwd, platform: process.platform }, io);
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

const rawArgs = process.argv.slice(2);
const namedArgs = {};
const positionalArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if ((rawArgs[i] === "--vault" || rawArgs[i] === "--alias") && rawArgs[i + 1]) {
    namedArgs[rawArgs[i].slice(2)] = rawArgs[++i];
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

const [adapterName, action] = positionalArgs;
const USAGE = `Usage:
  node adapter.mjs obsidian link --vault <path> [--alias <name>]
  node adapter.mjs obsidian status
  node adapter.mjs obsidian unlink`;

async function main() {
  if (adapterName !== "obsidian" || !["link", "status", "unlink"].includes(action || "")) {
    console.error(USAGE);
    process.exit(1);
  }

  const cwd = process.cwd();
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
      process.exit(1);
    }
    const result = await obsidianLink(
      { vaultPath: namedArgs.vault, alias, projectDir: cwd, platform: process.platform },
      io
    );
    printResult(result);
    if (!result.ok) process.exit(1);
    recordVaultPath(namedArgs.vault);
    recordProjectAdapter(cwd, projectConfig, alias);
    return;
  }

  // status / unlink resolve the Vault path from the user-level config.
  const vaultPath = vaultPathFromUserConfig();
  if (!vaultPath) {
    console.error("Error: no Obsidian Vault is configured for this user.");
    console.error("Run `/handoff adapter obsidian link --vault <path>` first.");
    process.exit(1);
  }

  if (action === "status") {
    await printStatus(vaultPath, alias, cwd);
    return;
  }

  const result = await obsidianUnlink({ vaultPath, alias, projectDir: cwd, platform: process.platform }, io);
  printResult(result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
