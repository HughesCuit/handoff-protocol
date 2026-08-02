#!/usr/bin/env node

/**
 * Handoff Protocol - Save Script (Node.js Reference Implementation)
 *
 * Usage:
 *   node save.mjs [mode] [--lang <lang>] [--verbosity <low|med|high>]
 *
 * Modes:
 *   (default) - Standard save
 *   compact   - Minimal summary
 *   full      - Maximum context
 *   diff      - Focus on changes
 *
 * Options:
 *   --lang <lang>             Override detected language
 *   --verbosity <low|med|high>  Control output detail (default: med)
 *     low:  commitCount=3, maxTodos=5, skip TODO scan, only HANDOFF.md + context.json
 *     med:  commitCount=5, maxTodos=20 (current behavior)
 *     high: commitCount=20, maxTodos=50, include all files
 *
 * Subcommands:
 *   node save.mjs init [direct|submodule]
 *   node save.mjs storage
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  buildInferredSections,
  filterSensitive,
  HANDOFF_FILES,
  MAP_FILENAME,
  parseContextMap,
  PROTOCOL_VERSION,
  reconcileContextMap,
  renderContextMap,
} from "./context-map.mjs";
import {
  buildContextJson,
  buildInitialV3Files,
  generateViews,
  sha256Hex,
  viewTamperWarnings,
} from "../views.mjs";
import {
  extractTodoComments,
  SCAN_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
} from "../source-comments.mjs";
import { CONFIG_FILENAME, validateProjectConfig } from "../config.mjs";
import { applyMigration, planMigration } from "../migrate.mjs";
import { writeSnapshot } from "../snapshots.mjs";

// ── Security ─────────────────────────────────────────────────────────────────
// SENSITIVE_PATTERNS and filterSensitive live in ./context-map.mjs (shared with
// the Deno runtime and the test suites).

// ── Command Execution ────────────────────────────────────────────────────────

function runCommand(cmd, opts) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch {
    return "";
  }
}

// ── Storage Config ───────────────────────────────────────────────────────────

function readStorageConfig(cwd) {
  const configPath = join(cwd, ".handoff.config.json");
  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    if (config.storage && config.storage.mode) return config;
    return null;
  } catch {
    return null;
  }
}

function writeStorageConfig(cwd, config) {
  writeFileSync(join(cwd, ".handoff.config.json"), JSON.stringify(config, null, 2) + "\n");
}

// Every operation that reads or writes .handoff.config.json goes through the
// shared validator: the file is portable project configuration, so absolute
// paths, home paths, Vault paths, and credential-like values are rejected
// (storage.remote submodule URLs excepted).
function validateConfigOrExit(config) {
  const result = validateProjectConfig(config);
  if (result.valid) return result.config;
  console.error("Error: invalid .handoff.config.json:");
  for (const err of result.errors) console.error(`  - ${err}`);
  console.error("Fix the file, or remove it and run `/handoff init` to reconfigure storage.");
  process.exit(1);
}

function isSubmoduleInitialized(cwd) {
  const gitmodulesPath = join(cwd, ".gitmodules");
  if (!existsSync(gitmodulesPath)) return false;
  try {
    return readFileSync(gitmodulesPath, "utf-8").includes(".handoff");
  } catch {
    return false;
  }
}

function hasRemote(cwd) {
  return !!runCommand("git remote", { cwd });
}

function initSubmodule(cwd, remoteUrl) {
  console.log(`Adding submodule from ${remoteUrl}...`);
  const result = runCommand(`git submodule add ${remoteUrl} .handoff`, { cwd });
  if (!result && result !== "") {
    console.error("Failed to add submodule.");
    return false;
  }
  console.log("Initializing submodule...");
  runCommand("git submodule update --init --recursive .handoff", { cwd });
  return true;
}

function ensureSubmoduleReady(cwd) {
  if (isSubmoduleInitialized(cwd)) {
    runCommand("git submodule update --init --recursive .handoff", { cwd });
    return true;
  }
  console.error("Error: .handoff is not registered as a submodule.");
  console.error("Run `/handoff init submodule` first.");
  return false;
}

function commitAndPushSubmodule(handoffDir) {
  for (const file of HANDOFF_FILES) {
    runCommand(`git add ${file}`, { cwd: handoffDir });
  }

  const commitResult = runCommand('git commit -m "Update handoff context"', { cwd: handoffDir });
  if (!commitResult) {
    console.log("No changes to commit in submodule (context unchanged).");
    return true;
  }

  const pushResult = runCommand("git push", { cwd: handoffDir });
  if (!pushResult) {
    console.error("Warning: Failed to push submodule. Changes are committed locally.");
    return false;
  }
  return true;
}

// ── Init Flow ────────────────────────────────────────────────────────────────

/**
 * Write the initial v3 layout (empty Context Map with an empty Current Goal,
 * eight empty content files, the generated view, and v3 metadata) into a
 * freshly initialized handoff directory. An existing handoff — including a
 * legacy v2 one awaiting migration — is left untouched.
 */
function writeInitialV3Layout(handoffDir, project) {
  if (existsSync(join(handoffDir, MAP_FILENAME))) return false;
  const files = buildInitialV3Files({
    project,
    timestamp: new Date().toISOString(),
    agent: process.env.AGENT_NAME || "opencode",
  });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(handoffDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return true;
}

async function promptUser(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function initStorage(cwd, mode) {
  let selectedMode = mode;

  if (!selectedMode) {
    console.log("");
    console.log("Handoff storage is not configured.");
    console.log("");
    console.log("Choose where to store .handoff:");
    console.log("");
    console.log("1. direct");
    console.log("   Store .handoff/ directly in this project.");
    console.log("   Recommended for private repositories or local-only projects.");
    console.log("");
    console.log("2. submodule");
    console.log("   Store .handoff/ as a Git submodule.");
    console.log("   Recommended for public repositories where handoff context");
    console.log("   should not be exposed.");
    console.log("");

    const choice = await promptUser("Please choose: direct or submodule. > ");
    if (choice === "1" || choice === "direct") selectedMode = "direct";
    else if (choice === "2" || choice === "submodule") selectedMode = "submodule";
    else {
      console.error("Invalid choice. Please run `/handoff init direct` or `/handoff init submodule`.");
      return null;
    }
  }

  if (selectedMode === "direct") {
    mkdirSync(join(cwd, ".handoff"), { recursive: true });

    const config = {
      version: PROTOCOL_VERSION,
      storage: { mode: "direct", path: ".handoff" },
    };
    validateConfigOrExit(config);
    writeStorageConfig(cwd, config);

    if (hasRemote(cwd)) {
      console.log("");
      console.log("Warning: .handoff/ may contain private context.");
      console.log("For public repositories, consider adding .handoff/ to .gitignore");
      console.log("or use submodule mode.");
      console.log("");

      const addGitignore = await promptUser("Add .handoff/ to .gitignore? (y/n) > ");
      if (addGitignore.toLowerCase() === "y" || addGitignore.toLowerCase() === "yes") {
        const gitignorePath = join(cwd, ".gitignore");
        let existing = "";
        try { existing = readFileSync(gitignorePath, "utf-8"); } catch {}
        if (!existing.includes(".handoff")) {
          const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
          writeFileSync(gitignorePath, `${existing}${sep}.handoff\n`);
          console.log("Added .handoff/ to .gitignore");
        }
      }
    }

    console.log("Initialized direct storage mode.");
    if (writeInitialV3Layout(join(cwd, ".handoff"), readProjectInfo().name)) {
      console.log("Created the initial v3 layout (context-map.md, content/, views/HANDOFF.md, context.json).");
    }
    return config;

  } else if (selectedMode === "submodule") {
    let remoteUrl = "";

    if (isSubmoduleInitialized(cwd)) {
      console.log("Submodule already registered.");
      try {
        const content = readFileSync(join(cwd, ".gitmodules"), "utf-8");
        const match = content.match(/url\s*=\s*(.+)/);
        if (match) remoteUrl = match[1].trim();
      } catch {}
    }

    if (!remoteUrl) {
      remoteUrl = await promptUser("Please provide the private handoff repository URL.\nExample: git@github.com:USER/PROJECT-handoff.git\n> ");
      if (!remoteUrl) {
        console.error("Error: Repository URL is required for submodule mode.");
        return null;
      }
    }

    if (!isSubmoduleInitialized(cwd)) {
      if (!initSubmodule(cwd, remoteUrl)) {
        console.error("Failed to initialize submodule.");
        return null;
      }
    }

    const config = {
      version: PROTOCOL_VERSION,
      storage: { mode: "submodule", path: ".handoff", remote: remoteUrl },
    };
    validateConfigOrExit(config);
    writeStorageConfig(cwd, config);

    console.log(`Initialized submodule storage mode.`);
    console.log(`Remote: ${remoteUrl}`);
    if (writeInitialV3Layout(join(cwd, ".handoff"), readProjectInfo().name)) {
      console.log("Created the initial v3 layout (context-map.md, content/, views/HANDOFF.md, context.json).");
    }
    return config;
  }

  return null;
}

// ── Auto-Analysis ────────────────────────────────────────────────────────────

function scanTodos(dir, maxFiles = 200) {
  const todos = [];
  let fileCount = 0;

  function walkDir(currentDir) {
    if (++fileCount > maxFiles) return;
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (fileCount > maxFiles) break;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) { if (!SCAN_EXCLUDED_DIRS.has(entry.name)) walkDir(fullPath); continue; }
      const ext = extname(entry.name);
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(ext)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        for (const hit of extractTodoComments(content, ext)) {
          const priority = (hit.tag === "FIXME" || hit.tag === "HACK") ? "high" : "medium";
          todos.push({ task: `${hit.text} (${relative(dir, fullPath)}:${hit.line})`, priority, status: "pending" });
        }
      } catch {}
    }
  }

  walkDir(dir);
  return todos.slice(0, 20);
}

function readProjectInfo() {
  const manifests = [
    { file: "package.json", lang: "typescript/javascript" },
    { file: "Cargo.toml", lang: "rust" },
    { file: "go.mod", lang: "go" },
    { file: "pyproject.toml", lang: "python" },
  ];
  for (const { file, lang } of manifests) {
    try {
      const content = readFileSync(file, "utf-8");
      if (file === "package.json") return { name: JSON.parse(content).name || "unknown", language: lang };
      if (file === "Cargo.toml") { const m = content.match(/name\s*=\s*"([^"]+)"/); return { name: m?.[1] || "unknown", language: lang }; }
      if (file === "go.mod") { const m = content.match(/module\s+(.+)/); return { name: m?.[1]?.split("/").pop() || "unknown", language: lang }; }
      if (file === "pyproject.toml") { const m = content.match(/name\s*=\s*"([^"]+)"/); return { name: m?.[1] || "unknown", language: lang }; }
    } catch {}
  }
  return { name: "unknown", language: "unknown" };
}

// ── Legacy migration ─────────────────────────────────────────────────────────

// Filesystem adapter for the shared, runtime-agnostic migration core.
const migrationIo = {
  readFile: async (p) => readFileSync(p, "utf-8"),
  writeFile: async (p, content) => writeFileSync(p, content),
  rename: async (from, to) => renameSync(from, to),
  mkdir: async (p) => mkdirSync(p, { recursive: true }),
  exists: async (p) => existsSync(p),
  remove: async (p) => rmSync(p, { force: true }),
};

// Filesystem adapter for the shared, runtime-agnostic snapshot core.
const snapshotIo = {
  readFile: async (p) => readFileSync(p, "utf-8"),
  writeFile: async (p, content) => writeFileSync(p, content),
  mkdir: async (p) => mkdirSync(p, { recursive: true }),
  listDir: async (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  remove: async (p) => rmSync(p, { force: true }),
};

/**
 * Migrate a legacy (pre-v2) handoff into the canonical model before the save
 * proceeds. The migration is atomic: originals are backed up under
 * .handoff/history/migrations/<UTC-timestamp>/ and only replaced after every
 * temporary output validates. Migrated nodes enter the map as user-owned
 * content, so they always win over this save's fresh inference. Returns the
 * migration diagnostics (recorded in context.json), or null when the handoff
 * is already v2.
 */
async function migrateLegacyHandoff(cwd, handoffDir) {
  const readIfExists = (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  };
  const plan = planMigration({
    config: readIfExists(join(cwd, CONFIG_FILENAME)),
    contextJson: readIfExists(join(handoffDir, "context.json")),
    handoffMd: readIfExists(join(handoffDir, "HANDOFF.md")),
    tasksMd: readIfExists(join(handoffDir, "tasks.md")),
    decisionsMd: readIfExists(join(handoffDir, "decisions.md")),
    contextMapMd: readIfExists(join(handoffDir, MAP_FILENAME)),
  });
  if (!plan.needed) return null;

  const result = await applyMigration(plan, { handoffDir, configPath: join(cwd, CONFIG_FILENAME) }, migrationIo);
  console.log(`Legacy handoff detected — migrated to Handoff Protocol v${PROTOCOL_VERSION}.`);
  console.log(`Backup: ${result.backupDir}`);
  for (const entry of plan.diagnostics.migration) console.log(`  - ${entry}`);
  if (plan.diagnostics.conflicts.length > 0) {
    console.log(`  - ${plan.diagnostics.conflicts.length} conflict(s) preserved under Open Questions > Migration conflict`);
  }
  return plan.diagnostics;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function save(mode, lang, verbosity) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");

  let storageConfig = readStorageConfig(cwd);
  if (!storageConfig) {
    storageConfig = await initStorage(cwd);
    if (!storageConfig) { console.error("Error: Storage initialization failed."); process.exit(1); }
  } else {
    validateConfigOrExit(storageConfig);
  }

  const storageMode = storageConfig.storage.mode;

  if (storageMode === "submodule") {
    if (!ensureSubmoduleReady(cwd)) process.exit(1);
  } else {
    mkdirSync(handoffDir, { recursive: true });
  }

  // Legacy (pre-v2) handoffs migrate atomically into the canonical model
  // before inference reconciles into the map below.
  const migrationDiagnostics = await migrateLegacyHandoff(cwd, handoffDir);

  const { name, language } = readProjectInfo();
  const gitBranch = runCommand("git branch --show-current") || "unknown";
  const gitCommit = runCommand("git log -1 --format=%h") || "unknown";
  const gitMessage = filterSensitive(runCommand("git log -1 --format=%s") || "");
  const gitDirty = !!runCommand("git status --porcelain");
  const git = { branch: gitBranch, latest_commit: gitCommit, commit_message: gitMessage, is_dirty: gitDirty };

  const commitCount = verbosity === "high" ? 20 : verbosity === "low" ? 3 : 5;
  const recentCommits = runCommand(`git log --oneline -n ${commitCount}`) || "";
  const commits = recentCommits.split("\n").filter((l) => l.trim());
  const inferredGoal = commits[0]?.replace(/^[a-f0-9]+\s+/, "") || "";
  const completed = commits.slice(1, commitCount).map((c) => c.replace(/^[a-f0-9]+\s+/, ""));

  const modifiedFiles = (runCommand("git status --porcelain") || "").split("\n").filter((l) => l.trim()).map((line) => {
    const sc = line.substring(0, 2).trim();
    const p = line.substring(3).trim();
    let ct = "modified";
    if (sc === "A") ct = "added"; else if (sc === "D") ct = "deleted"; else if (sc.startsWith("R")) ct = "renamed"; else if (sc === "??") ct = "untracked";
    return { path: p, description: "", change_type: ct };
  });

  const todos = verbosity === "low" ? [] : scanTodos(cwd);
  const maxTodos = verbosity === "high" ? 50 : verbosity === "low" ? 5 : 20;
  const status = modifiedFiles.length === 0 ? "idle - no pending changes" : git.is_dirty ? `in-progress - ${modifiedFiles.length} file(s) modified` : "ready - changes committed";

  const ctx = {
    version: PROTOCOL_VERSION, timestamp: new Date().toISOString(), agent: process.env.AGENT_NAME || "opencode",
    project: name, current_goal: inferredGoal, status, completed, modified_files: modifiedFiles,
    todos: todos.slice(0, maxTodos), blockers: [], decisions: [], next_steps: [], git, risks: [], notes: commits.join("\n"),
    lang: lang || language, verbosity,
  };

  // Context Map: the only writable semantic source. Inference reconciles
  // into context-map.md on every save, at every mode and verbosity level;
  // user-edited nodes always win over agent inference, and agent-managed
  // nodes are refreshed only by non-empty inference, so a low-verbosity save
  // never degrades the map. The sensitive-data filter is applied before any
  // content is written.
  const inferred = buildInferredSections(ctx);
  const mapPath = join(handoffDir, MAP_FILENAME);
  let existingMap = null;
  try {
    existingMap = parseContextMap(readFileSync(mapPath, "utf-8"));
  } catch {
    // Absent or unreadable: start from a fresh map.
  }
  const reconciled = reconcileContextMap(existingMap, inferred);
  const mapContent = filterSensitive(renderContextMap(reconciled, { lang: lang || undefined }));

  // HANDOFF.md / tasks.md / decisions.md are deterministic views generated
  // from the reconciled map plus save-time machine metadata — never from
  // inference directly.
  const metadata = {
    timestamp: ctx.timestamp,
    agent: ctx.agent,
    project: ctx.project,
    lang: ctx.lang,
    verbosity,
    git: ctx.git,
    completed,
    modifiedFiles,
    blockers: ctx.blockers,
    nextSteps: ctx.next_steps,
  };
  const views = {};
  for (const [name, content] of Object.entries(generateViews(reconciled, metadata, { verbosity }))) {
    views[name] = filterSensitive(content);
  }

  // Manual edits to generated views are overwritten, never imported. Warn
  // when the on-disk view no longer matches the hash stored by the last save.
  let previousViews = null;
  try {
    previousViews = JSON.parse(readFileSync(join(handoffDir, "context.json"), "utf-8")).views;
  } catch {
    // No readable previous context.json: nothing to compare against.
  }
  const currentContents = {};
  if (previousViews) {
    for (const name of Object.keys(previousViews)) {
      try {
        currentContents[name] = readFileSync(join(handoffDir, name), "utf-8");
      } catch {
        // Missing views are regenerated silently.
      }
    }
    for (const warning of viewTamperWarnings(previousViews, currentContents)) {
      console.error(warning);
    }
  }

  writeFileSync(mapPath, mapContent);
  for (const [name, content] of Object.entries(views)) {
    writeFileSync(join(handoffDir, name), content);
  }
  // context.json v2: metadata + Git state + hashes of the views just written.
  const viewHashes = {};
  for (const [name, content] of Object.entries(views)) {
    viewHashes[name] = sha256Hex(content);
  }
  // Low-verbosity saves do not rewrite tasks.md/decisions.md; carry their
  // stored hashes forward so tamper detection keeps covering them. Views
  // deleted on disk are dropped instead of haunting future saves.
  for (const [name, hash] of Object.entries(previousViews || {})) {
    if (!(name in viewHashes) && currentContents[name] != null) {
      viewHashes[name] = hash;
    }
  }
  const contextJson = buildContextJson(metadata, viewHashes, migrationDiagnostics || undefined);
  writeFileSync(join(handoffDir, "context.json"), filterSensitive(JSON.stringify(contextJson, null, 2)));

  // Semantic snapshot (v2.3): record the reconciled map after a successful
  // canonical save. Best-effort — a failed snapshot never fails the save.
  try {
    const snapshot = await writeSnapshot(reconciled, { handoffDir }, snapshotIo);
    if (snapshot.written) console.log(`Snapshot: ${snapshot.path}`);
  } catch (err) {
    console.error(`Warning: snapshot failed: ${err.message}`);
  }

  if (storageMode === "submodule") {
    if (commitAndPushSubmodule(handoffDir)) {
      console.log("\nHandoff context has been saved and pushed to the .handoff submodule.");
      console.log("The parent repository now has an updated submodule pointer.");
      console.log("Commit it in the parent repository only if you want collaborators to use this exact handoff revision.");
    }
  }

  console.log(`\nHandoff saved to ${handoffDir}`);
  console.log(`Storage: ${storageMode}`);
  console.log(`Mode: ${mode}`);
  console.log(`Language: ${lang || language}`);
  console.log(`Verbosity: ${verbosity}`);
  console.log(`Project: ${name} (${language})`);
  const savedFiles = verbosity === "low" ? "HANDOFF.md, context.json, context-map.md" : "HANDOFF.md, context.json, tasks.md, decisions.md, context-map.md";
  console.log(`Files: ${savedFiles}`);
  if (todos.length > 0) console.log(`Scanned: ${todos.length} TODO/FIXME items found`);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const namedArgs = {};
const positionalArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--lang" && rawArgs[i + 1]) { namedArgs.lang = rawArgs[++i]; }
  else if (rawArgs[i] === "--verbosity" && rawArgs[i + 1]) { namedArgs.verbosity = rawArgs[++i]; }
  else { positionalArgs.push(rawArgs[i]); }
}
const arg = positionalArgs[0] || "save";
const lang = namedArgs.lang || null;
const verbosity = namedArgs.verbosity || "med";
if (!["low", "med", "high"].includes(verbosity)) { console.error(`Error: Invalid verbosity '${verbosity}'. Must be low, med, or high.`); process.exit(1); }

if (arg === "init") {
  const mode = process.argv[3];
  initStorage(process.cwd(), mode).catch(console.error);
} else if (arg === "storage") {
  const config = readStorageConfig(process.cwd());
  if (!config) { console.log("Handoff storage is not configured.\nRun `/handoff init` to set up storage."); }
  else {
    validateConfigOrExit(config);
    console.log("Handoff storage:");
    console.log(`  mode: ${config.storage.mode}`);
    console.log(`  path: ${config.storage.path}`);
    if (config.storage.remote) console.log(`  remote: ${config.storage.remote}`);
  }
} else {
  // "save" with no mode arg means the default mode
  const mode = arg === "save" ? "default" : arg;
  const validModes = ["default", "compact", "full", "diff"];
  if (!validModes.includes(mode)) { console.error(`Error: Unknown mode '${arg}'\nValid modes: ${validModes.join(", ")}`); process.exit(1); }
  save(mode, lang, verbosity).catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
}
