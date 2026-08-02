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
  filterSensitive,
  MAP_FILENAME,
  V3_PROTOCOL_VERSION,
} from "./context-map.mjs";
import {
  buildInferredV3Sections,
  loadHandoffState,
  reconcileV3State,
} from "../handoff-state.mjs";
import { V3_TRACKED_PATHS } from "../content-files.mjs";
import {
  buildInitialV3Files,
  buildV3ContextJson,
  renderV3Files,
  sha256Hex,
  writeFilesAtomically,
} from "../views.mjs";
import {
  extractTodoComments,
  SCAN_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
} from "../source-comments.mjs";
import { CONFIG_FILENAME, validateProjectConfig } from "../config.mjs";
import { applyV3Migration, detectLayout, planV2ToV3Migration } from "../migrate-v3.mjs";
import { writeV3Snapshot } from "../snapshots.mjs";

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
  for (const file of V3_TRACKED_PATHS) {
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
      version: "2.0.0",
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
      version: "2.0.0",
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

// ── v3 migration and canonical state ───────────────────────────────────────

// Filesystem adapter for the shared, runtime-agnostic v3 cores (migration,
// atomic writes, snapshots, state loading).
const handoffIo = {
  readFile: async (p) => readFileSync(p, "utf-8"),
  writeFile: async (p, content) => writeFileSync(p, content),
  rename: async (from, to) => renameSync(from, to),
  mkdir: async (p) => mkdirSync(p, { recursive: true }),
  exists: async (p) => existsSync(p),
  listDir: async (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  remove: async (p) => rmSync(p, { force: true }),
};

function layoutOfDir(handoffDir) {
  let top;
  try {
    top = readdirSync(handoffDir);
  } catch {
    return "empty";
  }
  const files = [...top];
  for (const sub of ["content", "views"]) {
    try {
      for (const n of readdirSync(join(handoffDir, sub))) files.push(`${sub}/${n}`);
    } catch {
      // Subdirectory absent: not a v3 marker.
    }
  }
  return detectLayout(files);
}

/**
 * Migrate a pre-v3 handoff (v2 or legacy 1.x) into the canonical v3 model
 * before the save proceeds. Atomic: originals are backed up under
 * .handoff/history/migrations/<UTC-timestamp>/ and only replaced after every
 * temporary output validates; the config version upgrade renames last.
 * Returns the migration diagnostics (recorded in context.json), or null when
 * the handoff is already v3 or has no data.
 */
async function migrateToV3(cwd, handoffDir) {
  if (layoutOfDir(handoffDir) === "v3") return null;
  const readIfExists = (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  };
  const inputs = {
    config: readIfExists(join(cwd, CONFIG_FILENAME)),
    contextJson: readIfExists(join(handoffDir, "context.json")),
    handoffMd: readIfExists(join(handoffDir, "HANDOFF.md")),
    tasksMd: readIfExists(join(handoffDir, "tasks.md")),
    decisionsMd: readIfExists(join(handoffDir, "decisions.md")),
    contextMapMd: readIfExists(join(handoffDir, MAP_FILENAME)),
  };
  const hasAnyInput = Object.entries(inputs)
    .filter(([key]) => key !== "config")
    .some(([, value]) => value != null);
  if (!hasAnyInput) return null;

  const plan = planV2ToV3Migration(inputs);
  if (!plan.needed) return null;

  const result = await applyV3Migration(handoffIo, plan, { handoffDir, configPath: join(cwd, CONFIG_FILENAME) });
  console.log(`Previous handoff layout detected — migrated to Handoff Protocol v${V3_PROTOCOL_VERSION}.`);
  console.log(`Backup: ${result.backupDir}`);
  for (const entry of plan.diagnostics.migration) console.log(`  - ${entry}`);
  if (plan.diagnostics.conflicts.length > 0) {
    console.log(`  - ${plan.diagnostics.conflicts.length} conflict(s) preserved under Open Questions > Migration conflict`);
  }
  return plan.diagnostics;
}

/**
 * Load the canonical v3 state, tolerating a fresh (not yet initialized)
 * directory. A present-but-invalid state aborts the save rather than
 * destroying user content.
 */
async function loadExistingState(handoffDir) {
  if (!existsSync(join(handoffDir, MAP_FILENAME))) return null;
  return loadHandoffState(handoffIo, handoffDir);
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

  // Pre-v3 handoffs (v2 or legacy 1.x) migrate atomically into the canonical
  // v3 model before inference reconciles below.
  const migrationDiagnostics = await migrateToV3(cwd, handoffDir);

  const { name, language } = readProjectInfo();
  const gitBranch = runCommand("git branch --show-current") || "unknown";
  const gitCommit = runCommand("git log -1 --format=%h") || "unknown";
  const gitMessage = filterSensitive(runCommand("git log -1 --format=%s") || "");
  const gitDirty = !!runCommand("git status --porcelain");
  const git = { branch: gitBranch, latest_commit: gitCommit, commit_message: gitMessage, is_dirty: gitDirty };

  const commitCount = verbosity === "high" ? 20 : verbosity === "low" ? 3 : 5;
  const recentCommits = runCommand(`git log --oneline -n ${commitCount}`) || "";
  const commits = recentCommits.split("\n").filter((l) => l.trim());
  const completed = commits.slice(1, commitCount).map((c) => c.replace(/^[a-f0-9]+\s/, ""));

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

  const timestamp = new Date().toISOString();
  const agent = process.env.AGENT_NAME || "opencode";

  // Verified project evidence becomes inference. Current Goal is never
  // inferred: commit messages (including release commits) describe history,
  // not goals — only an explicit user goal or an existing valid goal
  // populates that section.
  const inferred = buildInferredV3Sections({
    status,
    todos: todos.slice(0, maxTodos),
    nextSteps: [],
    decisions: [],
    risks: [],
    blockers: [],
    notes: commits.join("\n"),
  });

  // Previous metadata supplies monotonic ID counters and view hashes.
  let previousJson = null;
  try {
    previousJson = JSON.parse(readFileSync(join(handoffDir, "context.json"), "utf-8"));
  } catch {
    // No readable previous context.json: counters recover from durable state.
  }

  // Reconcile the existing canonical state with fresh inference. User-owned
  // labels, bodies, hierarchy, and task states always win; IDs allocate only
  // for genuinely new semantic nodes.
  const existing = await loadExistingState(handoffDir);
  const reconciled = reconcileV3State({ existing, inferred, metadata: previousJson });
  const state = {
    version: V3_PROTOCOL_VERSION,
    map: reconciled.map,
    content: reconciled.content,
    diagnostics: reconciled.diagnostics,
  };

  // Manual edits to the generated view are overwritten, never imported. Warn
  // when the on-disk view no longer matches the hash stored by the last save.
  const storedViewHash = previousJson && previousJson.hashes && previousJson.hashes["views/HANDOFF.md"];
  if (storedViewHash) {
    try {
      const current = readFileSync(join(handoffDir, "views", "HANDOFF.md"), "utf-8");
      if (sha256Hex(current) !== storedViewHash) {
        console.error(
          "Warning: views/HANDOFF.md was manually edited, but it is generated from context-map.md and the content/ files. " +
          "Edit those instead — manual view changes are never imported and are overwritten on save."
        );
      }
    } catch {
      // Missing views are regenerated silently.
    }
  }

  // Render every file from the canonical state and filter sensitive data
  // before anything is persisted.
  const metadata = { timestamp, agent, project: name, lang: lang || language, git };
  const files = {};
  for (const [file, content] of Object.entries(renderV3Files(state, metadata))) {
    files[file] = filterSensitive(content);
  }
  const contextJson = buildV3ContextJson({
    state,
    project: name,
    git,
    environment: { timestamp, agent, lang: metadata.lang },
    diagnostics: {
      migration: (migrationDiagnostics && migrationDiagnostics.migration) || [],
      conflicts: (migrationDiagnostics && migrationDiagnostics.conflicts) || [],
      integrity: reconciled.diagnostics,
    },
    files,
  });
  // Counters are monotonic across deletions; the reconciled high-water marks
  // win over what a fresh recovery would observe.
  contextJson.idCounters = reconciled.counters;
  files["context.json"] = filterSensitive(JSON.stringify(contextJson, null, 2));

  await writeFilesAtomically(handoffIo, handoffDir, files);

  for (const diagnostic of reconciled.diagnostics) {
    console.error(`Note: ${diagnostic}`);
  }

  // Semantic snapshot: record the canonical state after a successful save.
  // Best-effort — a failed snapshot never fails the save.
  try {
    const snapshot = await writeV3Snapshot(state, { handoffDir }, handoffIo);
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
  console.log(`Files: context-map.md, content/ (8 section files), views/HANDOFF.md, context.json`);
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
