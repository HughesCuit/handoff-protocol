#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * Handoff Protocol - Save Script
 *
 * Collects current work context and writes to .handoff/ directory.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run save.ts [mode]
 *
 * Modes:
 *   (default) - Standard save with current state
 *   compact   - Minimal summary (goal + status + next steps only)
 *   full      - Maximum context (extended history, full diff stats)
 *   diff      - Focus on code changes
 *
 * Additional flags:
 *   --lang <code>        Language for output (e.g. en, zh, ja). Default: auto-detect
 *   --verbosity <level>  Detail level: low, med, high. Overrides mode defaults
 *
 * Storage modes (configured via .handoff.config.json):
 *   direct    - .handoff/ as local directory
 *   submodule - .handoff/ as git submodule
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { ensureDir, walk, exists } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join, extname } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  filterSensitive,
  HANDOFF_FILES,
  PROTOCOL_VERSION,
  CONTEXT_MAP_FILE,
  buildInferredSections,
  parseContextMap,
  reconcileContextMap,
  renderContextMap,
} from "./context-map.ts";
import {
  buildContextJson,
  generateViews,
  sha256Hex,
  viewTamperWarnings,
} from "./views.mjs";
import {
  extractTodoComments,
  SCAN_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
} from "./source-comments.mjs";
import { validateProjectConfig } from "./config.mjs";
import { applyMigration, planMigration } from "./migrate.mjs";

// ── Types ────────────────────────────────────────────────────────────────────

interface ModifiedFile {
  path: string;
  description: string;
  change_type: string;
}

interface TodoItem {
  task: string;
  priority: string;
  status: string;
}

interface Decision {
  title: string;
  context: string;
  decision: string;
  rationale: string;
}

interface HandoffContext {
  version: string;
  timestamp: string;
  agent: string;
  project: string;
  current_goal: string;
  status: string;
  completed: string[];
  modified_files: ModifiedFile[];
  todos: TodoItem[];
  blockers: string[];
  decisions: Decision[];
  next_steps: string[];
  git: {
    branch: string;
    latest_commit: string;
    commit_message: string;
    is_dirty: boolean;
  };
  risks: string[];
  notes: string;
  lang?: string;
  verbosity?: string;
}

interface StorageConfig {
  version: string;
  storage: {
    mode: "direct" | "submodule";
    path: string;
    remote?: string;
  };
}

// ── Security ─────────────────────────────────────────────────────────────────
// SENSITIVE_PATTERNS and filterSensitive live in ./context-map.ts (shared with
// the Node runtime and the test suites).

// ── Command Execution ────────────────────────────────────────────────────────

async function runCommand(
  cmd: string[],
  opts?: { cwd?: string }
): Promise<{ stdout: string; code: number }> {
  try {
    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      cwd: opts?.cwd,
    });
    const { code, stdout } = await command.output();
    return { stdout: new TextDecoder().decode(stdout).trim(), code };
  } catch {
    return { stdout: "", code: -1 };
  }
}

async function run(cmd: string[], opts?: { cwd?: string }): Promise<string> {
  const { stdout } = await runCommand(cmd, opts);
  return stdout;
}

// ── Storage Config ───────────────────────────────────────────────────────────

async function readStorageConfig(cwd: string): Promise<StorageConfig | null> {
  const configPath = join(cwd, ".handoff.config.json");
  try {
    const content = await Deno.readTextFile(configPath);
    const config = JSON.parse(content) as StorageConfig;
    if (config.storage && config.storage.mode) {
      return config;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeStorageConfig(cwd: string, config: StorageConfig): Promise<void> {
  const configPath = join(cwd, ".handoff.config.json");
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

// Every operation that reads or writes .handoff.config.json goes through the
// shared validator: the file is portable project configuration, so absolute
// paths, home paths, Vault paths, and credential-like values are rejected
// (storage.remote submodule URLs excepted).
function validateConfigOrExit(config: StorageConfig): StorageConfig {
  const result = validateProjectConfig(config);
  if (result.valid) return config;
  console.error("Error: invalid .handoff.config.json:");
  for (const err of result.errors) console.error(`  - ${err}`);
  console.error("Fix the file, or remove it and run `/handoff init` to reconfigure storage.");
  Deno.exit(1);
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await runCommand(["git", "rev-parse", "--git-dir"], { cwd });
  return code === 0;
}

async function isSubmoduleInitialized(cwd: string): Promise<boolean> {
  const gitmodulesPath = join(cwd, ".gitmodules");
  if (!await exists(gitmodulesPath)) return false;

  try {
    const content = await Deno.readTextFile(gitmodulesPath);
    return content.includes('.handoff');
  } catch {
    return false;
  }
}

async function isInGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = join(cwd, ".gitignore");
  try {
    const content = await Deno.readTextFile(gitignorePath);
    const lines = content.split("\n").map((l) => l.trim());
    return lines.some((l) => l === ".handoff" || l === ".handoff/" || l === ".handoff/**");
  } catch {
    return false;
  }
}

async function hasRemote(cwd: string): Promise<boolean> {
  const remote = await run(["git", "remote"], { cwd });
  return remote.length > 0;
}

async function initSubmodule(cwd: string, remoteUrl: string): Promise<boolean> {
  console.log(`Adding submodule from ${remoteUrl}...`);
  const { code } = await runCommand(["git", "submodule", "add", remoteUrl, ".handoff"], { cwd });
  if (code !== 0) {
    console.error("Failed to add submodule.");
    return false;
  }

  console.log("Initializing submodule...");
  const { code: initCode } = await runCommand(
    ["git", "submodule", "update", "--init", "--recursive", ".handoff"],
    { cwd }
  );
  return initCode === 0;
}

async function ensureSubmoduleReady(cwd: string): Promise<boolean> {
  // Check if .handoff is a submodule
  if (await isSubmoduleInitialized(cwd)) {
    // Try to init/update
    const { code } = await runCommand(
      ["git", "submodule", "update", "--init", "--recursive", ".handoff"],
      { cwd }
    );
    if (code !== 0) {
      console.error("Unable to initialize .handoff submodule.");
      console.error("This may be a private repository. Please make sure your SSH key");
      console.error("or GitHub credentials have access to the remote repository.");
      return false;
    }
    return true;
  }

  console.error("Error: .handoff is not registered as a submodule.");
  console.error("Run `/handoff init submodule` first.");
  return false;
}

async function commitAndPushSubmodule(handoffDir: string): Promise<boolean> {
  for (const file of HANDOFF_FILES) {
    await run(["git", "add", file], { cwd: handoffDir });
  }

  const { code: commitCode } = await runCommand(
    ["git", "commit", "-m", "Update handoff context"],
    { cwd: handoffDir }
  );

  if (commitCode !== 0) {
    // No changes to commit is OK
    console.log("No changes to commit in submodule (context unchanged).");
    return true;
  }

  const { code: pushCode } = await runCommand(["git", "push"], { cwd: handoffDir });
  if (pushCode !== 0) {
    console.error("Warning: Failed to push submodule. Changes are committed locally.");
    return false;
  }

  return true;
}

// ── Init Flow ────────────────────────────────────────────────────────────────

async function promptUser(message: string): Promise<string> {
  const buf = new Uint8Array(1024);
  await Deno.stdout.write(new TextEncoder().encode(message));
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

async function initStorage(cwd: string, mode?: string): Promise<StorageConfig | null> {
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
    if (choice === "1" || choice === "direct") {
      selectedMode = "direct";
    } else if (choice === "2" || choice === "submodule") {
      selectedMode = "submodule";
    } else {
      console.error("Invalid choice. Please run `/handoff init direct` or `/handoff init submodule`.");
      return null;
    }
  }

  if (selectedMode === "direct") {
    await ensureDir(join(cwd, ".handoff"));

    const config: StorageConfig = {
      version: PROTOCOL_VERSION,
      storage: { mode: "direct", path: ".handoff" },
    };
    validateConfigOrExit(config);
    await writeStorageConfig(cwd, config);

    // Check if public repo and warn
    if (await hasRemote(cwd)) {
      console.log("");
      console.log("Warning: .handoff/ may contain private context.");
      console.log("");
      console.log("For public repositories, consider adding .handoff/ to .gitignore");
      console.log("or use submodule mode.");
      console.log("");

      const addGitignore = await promptUser("Add .handoff/ to .gitignore? (y/n) > ");
      if (addGitignore.toLowerCase() === "y" || addGitignore.toLowerCase() === "yes") {
        const gitignorePath = join(cwd, ".gitignore");
        let existing = "";
        try {
          existing = await Deno.readTextFile(gitignorePath);
        } catch {
          // no .gitignore yet
        }
        if (!existing.includes(".handoff")) {
          const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
          await Deno.writeTextFile(gitignorePath, `${existing}${separator}.handoff\n`);
          console.log("Added .handoff/ to .gitignore");
        }
      }
    }

    console.log("Initialized direct storage mode.");
    return config;

  } else if (selectedMode === "submodule") {
    let remoteUrl = "";

    // Check if submodule already exists
    if (await isSubmoduleInitialized(cwd)) {
      console.log("Submodule already registered.");
      // Read remote from .gitmodules
      try {
        const content = await Deno.readTextFile(join(cwd, ".gitmodules"));
        const match = content.match(/url\s*=\s*(.+)/);
        if (match) remoteUrl = match[1].trim();
      } catch {
        // ignore
      }
    }

    if (!remoteUrl) {
      remoteUrl = await promptUser("Please provide the private handoff repository URL.\nExample: git@github.com:USER/PROJECT-handoff.git\n> ");
      if (!remoteUrl) {
        console.error("Error: Repository URL is required for submodule mode.");
        return null;
      }
    }

    // Init submodule
    if (!await isSubmoduleInitialized(cwd)) {
      const success = await initSubmodule(cwd, remoteUrl);
      if (!success) {
        console.error("Failed to initialize submodule.");
        return null;
      }
    }

    const config: StorageConfig = {
      version: PROTOCOL_VERSION,
      storage: { mode: "submodule", path: ".handoff", remote: remoteUrl },
    };
    validateConfigOrExit(config);
    await writeStorageConfig(cwd, config);

    console.log(`Initialized submodule storage mode.`);
    console.log(`Remote: ${remoteUrl}`);
    return config;
  }

  return null;
}

// ── Git Functions ────────────────────────────────────────────────────────────

async function getGitState(): Promise<HandoffContext["git"]> {
  const [branch, latestCommit, commitMessage, status] = await Promise.all([
    run(["git", "branch", "--show-current"]),
    run(["git", "log", "-1", "--format=%h"]),
    run(["git", "log", "-1", "--format=%s"]),
    run(["git", "status", "--porcelain"]),
  ]);

  return {
    branch: branch || "unknown",
    latest_commit: latestCommit || "unknown",
    commit_message: filterSensitive(commitMessage || ""),
    is_dirty: status.length > 0,
  };
}

async function getModifiedFiles(): Promise<ModifiedFile[]> {
  const status = await run(["git", "status", "--porcelain"]);
  if (!status) return [];

  return status
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const statusCode = line.substring(0, 2).trim();
      const path = line.substring(3).trim();
      let changeType = "modified";
      if (statusCode === "A") changeType = "added";
      else if (statusCode === "D") changeType = "deleted";
      else if (statusCode.startsWith("R")) changeType = "renamed";
      else if (statusCode === "??") changeType = "untracked";
      return { path, description: "", change_type: changeType };
    });
}

async function getRecentCommits(count: number = 5): Promise<string[]> {
  const log = await run(["git", "log", "--oneline", "-n", count.toString()]);
  if (!log) return [];
  return log.split("\n").filter((line) => line.trim());
}

async function getDiffSummary(): Promise<string> {
  return await run(["git", "diff", "--shortstat"]) ||
    await run(["git", "diff", "--shortstat", "--cached"]) || "";
}

// ── Auto-Analysis ────────────────────────────────────────────────────────────

const SKIP_DIR_PATTERNS = [...SCAN_EXCLUDED_DIRS].map(
  (name) => new RegExp(`(^|[/\\\\])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/\\\\]|$)`)
);

async function scanTodos(cwd: string): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];
  let fileCount = 0;
  const maxFiles = 200;

  try {
    for await (const entry of walk(cwd, { skip: SKIP_DIR_PATTERNS })) {
      if (!entry.isFile) continue;
      const ext = extname(entry.path);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (++fileCount > maxFiles) break;

      try {
        const content = await Deno.readTextFile(entry.path);
        for (const hit of extractTodoComments(content, ext)) {
          const priority = hit.tag === "FIXME" ? "high" : hit.tag === "HACK" ? "high" : "medium";
          const relPath = entry.path.replace(cwd + "/", "");
          todos.push({
            task: `${hit.text} (${relPath}:${hit.line})`,
            priority,
            status: "pending",
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // walk failed, skip
  }

  return todos.slice(0, 20);
}

function inferGoalFromCommits(commits: string[]): string {
  if (commits.length === 0) return "";
  return commits[0].replace(/^[a-f0-9]+\s+/, "");
}

function inferCompletedFromCommits(commits: string[]): string[] {
  return commits.slice(1, 6).map((c) => c.replace(/^[a-f0-9]+\s+/, ""));
}

function inferStatusFromGit(git: HandoffContext["git"], modifiedFiles: ModifiedFile[]): string {
  if (modifiedFiles.length === 0) return "idle - no pending changes";
  if (git.is_dirty) return `in-progress - ${modifiedFiles.length} file(s) modified`;
  return "ready - changes committed";
}

function inferRisksFromState(
  git: HandoffContext["git"],
  todos: TodoItem[],
  modifiedFiles: ModifiedFile[]
): string[] {
  const risks: string[] = [];

  const highPriority = todos.filter((t) => t.priority === "high" && t.status === "pending");
  if (highPriority.length > 0) {
    risks.push(`${highPriority.length} high-priority TODO/FIXME items pending`);
  }

  const untracked = modifiedFiles.filter((f) => f.change_type === "untracked");
  if (untracked.length > 3) {
    risks.push(`${untracked.length} untracked files - consider adding to version control`);
  }

  return risks;
}

// ── Project Detection ────────────────────────────────────────────────────────

async function readProjectInfo(): Promise<{ name: string; language: string }> {
  const manifests = [
    { file: "package.json", lang: "typescript/javascript" },
    { file: "Cargo.toml", lang: "rust" },
    { file: "go.mod", lang: "go" },
    { file: "pyproject.toml", lang: "python" },
    { file: "setup.py", lang: "python" },
    { file: "pom.xml", lang: "java" },
  ];

  for (const { file, lang } of manifests) {
    try {
      const content = await Deno.readTextFile(file);
      if (file === "package.json") {
        const pkg = JSON.parse(content);
        return { name: pkg.name || "unknown", language: lang };
      }
      if (file === "Cargo.toml") {
        const m = content.match(/name\s*=\s*"([^"]+)"/);
        return { name: m?.[1] || "unknown", language: lang };
      }
      if (file === "go.mod") {
        const m = content.match(/module\s+(.+)/);
        return { name: m?.[1]?.split("/").pop() || "unknown", language: lang };
      }
      if (file === "pyproject.toml") {
        const m = content.match(/name\s*=\s*"([^"]+)"/);
        return { name: m?.[1] || "unknown", language: lang };
      }
      if (file === "pom.xml") {
        const m = content.match(/<artifactId>([^<]+)<\/artifactId>/);
        return { name: m?.[1] || "unknown", language: lang };
      }
    } catch {
      continue;
    }
  }
  return { name: "unknown", language: "unknown" };
}

// ── Mode Handling ────────────────────────────────────────────────────────────

interface ModeConfig {
  commitCount: number;
  maxTodos: number;
  includeDiffStat: boolean;
  includeRiskAnalysis: boolean;
  includeTodoScan: boolean;
  includeExtendedAnalysis: boolean;
}

function getModeConfig(mode: string, verbosity?: string): ModeConfig {
  // --verbosity overrides mode defaults
  if (verbosity === "low") {
    return {
      commitCount: 3,
      maxTodos: 5,
      includeDiffStat: false,
      includeRiskAnalysis: false,
      includeTodoScan: false,
      includeExtendedAnalysis: false,
    };
  }
  if (verbosity === "high") {
    return {
      commitCount: 20,
      maxTodos: 50,
      includeDiffStat: true,
      includeRiskAnalysis: true,
      includeTodoScan: true,
      includeExtendedAnalysis: true,
    };
  }
  // verbosity === "med" or undefined: use mode defaults
  switch (mode) {
    case "compact":
      return {
        commitCount: 3,
        maxTodos: 5,
        includeDiffStat: false,
        includeRiskAnalysis: false,
        includeTodoScan: false,
        includeExtendedAnalysis: false,
      };
    case "full":
      return {
        commitCount: 20,
        maxTodos: 50,
        includeDiffStat: true,
        includeRiskAnalysis: true,
        includeTodoScan: true,
        includeExtendedAnalysis: true,
      };
    case "diff":
      return {
        commitCount: 5,
        maxTodos: 10,
        includeDiffStat: true,
        includeRiskAnalysis: false,
        includeTodoScan: false,
        includeExtendedAnalysis: false,
      };
    default: // standard
      return {
        commitCount: 5,
        maxTodos: 20,
        includeDiffStat: true,
        includeRiskAnalysis: true,
        includeTodoScan: true,
        includeExtendedAnalysis: false,
      };
  }
}

// ── Main Save Logic ──────────────────────────────────────────────────────────

// Filesystem adapter for the shared, runtime-agnostic migration core.
const migrationIo = {
  readFile: (p: string) => Deno.readTextFile(p),
  writeFile: async (p: string, content: string) => {
    await Deno.writeTextFile(p, content);
  },
  rename: (from: string, to: string) => Deno.rename(from, to),
  mkdir: async (p: string) => {
    await Deno.mkdir(p, { recursive: true });
  },
  exists: (p: string) => exists(p),
  remove: async (p: string) => {
    try {
      await Deno.remove(p);
    } catch {
      // Already renamed or never written: nothing to clean.
    }
  },
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
async function migrateLegacyHandoff(
  cwd: string,
  handoffDir: string,
): Promise<{ migration: string[]; conflicts: unknown[] } | null> {
  const readIfExists = async (p: string): Promise<string | undefined> => {
    try {
      return await Deno.readTextFile(p);
    } catch {
      return undefined;
    }
  };
  const plan = planMigration({
    config: await readIfExists(join(cwd, ".handoff.config.json")),
    contextJson: await readIfExists(join(handoffDir, "context.json")),
    handoffMd: await readIfExists(join(handoffDir, "HANDOFF.md")),
    tasksMd: await readIfExists(join(handoffDir, "tasks.md")),
    decisionsMd: await readIfExists(join(handoffDir, "decisions.md")),
    contextMapMd: await readIfExists(join(handoffDir, CONTEXT_MAP_FILE)),
  });
  if (!plan.needed) return null;

  const result = await applyMigration(
    plan,
    { handoffDir, configPath: join(cwd, ".handoff.config.json") },
    migrationIo,
  );
  console.log(`Legacy handoff detected — migrated to Handoff Protocol v${PROTOCOL_VERSION}.`);
  console.log(`Backup: ${result.backupDir}`);
  for (const entry of plan.diagnostics.migration) console.log(`  - ${entry}`);
  if (plan.diagnostics.conflicts.length > 0) {
    console.log(`  - ${plan.diagnostics.conflicts.length} conflict(s) preserved under Open Questions > Migration conflict`);
  }
  return plan.diagnostics;
}

async function save(mode: string, lang?: string, verbosity?: string): Promise<void> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");
  const config = getModeConfig(mode, verbosity);

  // Check git availability
  const gitAvailable = (await run(["git", "--version"])).length > 0;
  if (!gitAvailable) {
    console.error("Error: git is not available. Install git or run in a git repository.");
    console.error("Falling back to file-scan mode.");
  }

  // Read storage config
  let storageConfig = await readStorageConfig(cwd);

  if (!storageConfig) {
    // Need to initialize
    storageConfig = await initStorage(cwd);
    if (!storageConfig) {
      console.error("Error: Storage initialization failed. Cannot save.");
      Deno.exit(1);
    }
  } else {
    validateConfigOrExit(storageConfig);
  }

  const storageMode = storageConfig.storage.mode;

  // Ensure .handoff is ready based on storage mode
  if (storageMode === "submodule") {
    const ready = await ensureSubmoduleReady(cwd);
    if (!ready) Deno.exit(1);
  } else {
    await ensureDir(handoffDir);
  }

  // Legacy (pre-v2) handoffs migrate atomically into the canonical model
  // before inference reconciles into the map below.
  const migrationDiagnostics = await migrateLegacyHandoff(cwd, handoffDir);

  const { name, language } = await readProjectInfo();
  const git = await getGitState();
  const modifiedFiles = await getModifiedFiles();
  const recentCommits = await getRecentCommits(config.commitCount);

  // Auto-analysis
  const todos = config.includeTodoScan ? await scanTodos(cwd) : [];
  const inferredGoal = inferGoalFromCommits(recentCommits);
  const completed = inferCompletedFromCommits(recentCommits);
  const status = inferStatusFromGit(git, modifiedFiles);
  const risks = config.includeRiskAnalysis
    ? inferRisksFromState(git, todos, modifiedFiles)
    : [];

  // Diff mode: add diff summary to notes
  let notes = recentCommits.join("\n");
  if (config.includeDiffStat) {
    const diffSummary = await getDiffSummary();
    if (diffSummary) {
      notes = `Diff summary: ${diffSummary}\n\n${notes}`;
    }
  }

  const ctx: HandoffContext = {
    version: PROTOCOL_VERSION,
    timestamp: new Date().toISOString(),
    agent: Deno.env.get("AGENT_NAME") || "opencode",
    project: name,
    current_goal: inferredGoal,
    status,
    completed,
    modified_files: modifiedFiles,
    todos: todos.slice(0, config.maxTodos),
    blockers: [],
    decisions: [],
    next_steps: [],
    git,
    risks,
    notes,
    lang,
    verbosity,
  };

  // Context Map: the only writable semantic source. Inference reconciles
  // into context-map.md on every save, at every mode and verbosity level;
  // user-edited nodes always win over agent inference, and agent-managed
  // nodes are refreshed only by non-empty inference, so a low-verbosity save
  // never degrades the map. The sensitive-data filter is applied before any
  // content is written.
  const inferred = buildInferredSections(ctx);
  const mapPath = join(handoffDir, CONTEXT_MAP_FILE);
  let existingMap = null;
  try {
    existingMap = parseContextMap(await Deno.readTextFile(mapPath));
  } catch {
    // Absent or unreadable: start from a fresh map.
  }
  const reconciled = reconcileContextMap(existingMap, inferred);
  const mapContent = filterSensitive(renderContextMap(reconciled, { lang }));

  // HANDOFF.md / tasks.md / decisions.md are deterministic views generated
  // from the reconciled map plus save-time machine metadata — never from
  // inference directly.
  const metadata = {
    timestamp: ctx.timestamp,
    agent: ctx.agent,
    project: ctx.project,
    lang: lang || language,
    verbosity: ctx.verbosity,
    git: ctx.git,
    completed,
    modifiedFiles,
    blockers: ctx.blockers,
    nextSteps: ctx.next_steps,
  };
  const views: Record<string, string> = {};
  for (const [name, content] of Object.entries(generateViews(reconciled, metadata, { verbosity }))) {
    views[name] = filterSensitive(content as string);
  }

  // Manual edits to generated views are overwritten, never imported. Warn
  // when the on-disk view no longer matches the hash stored by the last save.
  let previousViews: Record<string, string> | null = null;
  try {
    previousViews = JSON.parse(await Deno.readTextFile(join(handoffDir, "context.json"))).views;
  } catch {
    // No readable previous context.json: nothing to compare against.
  }
  const currentContents: Record<string, string> = {};
  if (previousViews) {
    for (const name of Object.keys(previousViews)) {
      try {
        currentContents[name] = await Deno.readTextFile(join(handoffDir, name));
      } catch {
        // Missing views are regenerated silently.
      }
    }
    for (const warning of viewTamperWarnings(previousViews, currentContents)) {
      console.error(warning);
    }
  }

  const writeOps: Promise<void>[] = [Deno.writeTextFile(mapPath, mapContent)];
  for (const [name, content] of Object.entries(views)) {
    writeOps.push(Deno.writeTextFile(join(handoffDir, name), content));
  }
  await Promise.all(writeOps);

  // context.json v2: metadata + Git state + hashes of the views just written.
  const viewHashes: Record<string, string> = {};
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
  await Deno.writeTextFile(
    join(handoffDir, "context.json"),
    filterSensitive(JSON.stringify(contextJson, null, 2))
  );

  let fileSummary = "HANDOFF.md, context.json, context-map.md";
  if (verbosity !== "low") {
    fileSummary += ", tasks.md, decisions.md";
  }

  // Post-save actions based on storage mode
  if (storageMode === "submodule") {
    const pushed = await commitAndPushSubmodule(handoffDir);
    if (pushed) {
      console.log("");
      console.log("Handoff context has been saved and pushed to the .handoff submodule.");
      console.log("");
      console.log("The parent repository now has an updated submodule pointer.");
      console.log("Commit it in the parent repository only if you want collaborators");
      console.log("to use this exact handoff revision.");
    }
  }

  console.log("");
  console.log(`Handoff saved to ${handoffDir}`);
  console.log(`Storage: ${storageMode}`);
  console.log(`Mode: ${mode}`);
  console.log(`Lang: ${lang || "(auto-detect)"}`);
  console.log(`Verbosity: ${verbosity || "med (default)"}`);
  console.log(`Project: ${name} (${language})`);
  console.log(`Goal: ${inferredGoal || "(inferred from commits)"}`);
  console.log(`Files: ${fileSummary}`);
  if (todos.length > 0) {
    console.log(`Scanned: ${todos.length} TODO/FIXME items found`);
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["save"] },
  });

  const lang = args.lang as string | undefined;
  const verbosity = args.verbosity as string | undefined;

  const subcommand = args._[0]?.toString() || "save";

  // Handle init subcommand
  if (subcommand === "init") {
    const mode = args._[1]?.toString();
    const cwd = Deno.cwd();
    await initStorage(cwd, mode);
    return;
  }

  // Handle storage subcommand
  if (subcommand === "storage") {
    const cwd = Deno.cwd();
    const config = await readStorageConfig(cwd);
    if (!config) {
      console.log("Handoff storage is not configured.");
      console.log("Run `/handoff init` to set up storage.");
      return;
    }
    validateConfigOrExit(config);
    console.log("Handoff storage:");
    console.log(`  mode: ${config.storage.mode}`);
    console.log(`  path: ${config.storage.path}`);
    if (config.storage.remote) {
      console.log(`  remote: ${config.storage.remote}`);
    }
    return;
  }

  // Handle save with mode ("save" with no mode arg means the default mode)
  const mode = subcommand === "save" ? "default" : subcommand;
  const validModes = ["default", "compact", "full", "diff"];
  if (!validModes.includes(mode)) {
    console.error(`Error: Unknown mode '${mode}'`);
    console.error(`Valid modes: ${validModes.join(", ")}`);
    Deno.exit(1);
  }

  try {
    await save(mode, lang, verbosity);
  } catch (err) {
    console.error(`Error during save: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

main();
