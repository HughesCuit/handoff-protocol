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
import { join, extname, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  filterSensitive,
  V3_PROTOCOL_VERSION,
  CONTEXT_MAP_FILE,
} from "./context-map.ts";
import {
  buildInferredV3Sections,
  loadHandoffState,
  reconcileV3State,
} from "./handoff-state.mjs";
import { V3_TRACKED_PATHS } from "./content-files.mjs";
import {
  buildInitialV3Files,
  buildV3ContextJson,
  renderV3Files,
  sha256Hex,
  writeFilesAtomically,
} from "./views.mjs";
import {
  extractTodoComments,
  SCAN_EXCLUDED_DIRS,
  SOURCE_EXTENSIONS,
} from "./source-comments.mjs";
import { validateProjectConfig } from "./config.mjs";
import { applyV3Migration, detectLayout, planV2ToV3Migration } from "./migrate-v3.mjs";
import { writeV3Snapshot } from "./snapshots.mjs";

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
  for (const file of V3_TRACKED_PATHS) {
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

  // Write the initial v3 layout (empty Context Map with an empty Current
  // Goal, eight empty content files, the generated view, and v3 metadata)
  // into a freshly initialized handoff directory. An existing handoff —
  // including a legacy v2 one awaiting migration — is left untouched.
  const writeInitialV3Layout = async (handoffDir: string, project: string): Promise<boolean> => {
    if (await exists(join(handoffDir, CONTEXT_MAP_FILE))) return false;
    const files = buildInitialV3Files({
      project,
      timestamp: new Date().toISOString(),
      agent: Deno.env.get("AGENT_NAME") || "opencode",
    });
    for (const [rel, content] of Object.entries(files)) {
      const path = join(handoffDir, rel);
      await ensureDir(dirname(path));
      await Deno.writeTextFile(path, content);
    }
    return true;
  };

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
      version: V3_PROTOCOL_VERSION,
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
    if (await writeInitialV3Layout(join(cwd, ".handoff"), (await readProjectInfo()).name)) {
      console.log("Created the initial v3 layout (context-map.md, content/, views/HANDOFF.md, context.json).");
    }
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
      version: V3_PROTOCOL_VERSION,
      storage: { mode: "submodule", path: ".handoff", remote: remoteUrl },
    };
    validateConfigOrExit(config);
    await writeStorageConfig(cwd, config);

    console.log(`Initialized submodule storage mode.`);
    console.log(`Remote: ${remoteUrl}`);
    if (await writeInitialV3Layout(join(cwd, ".handoff"), (await readProjectInfo()).name)) {
      console.log("Created the initial v3 layout (context-map.md, content/, views/HANDOFF.md, context.json).");
    }
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

// Filesystem adapter for the shared, runtime-agnostic snapshot core.
const snapshotIo = {
  readFile: (p: string) => Deno.readTextFile(p),
  writeFile: async (p: string, content: string) => {
    await Deno.writeTextFile(p, content);
  },
  mkdir: async (p: string) => {
    await Deno.mkdir(p, { recursive: true });
  },
  listDir: async (p: string): Promise<string[]> => {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(p)) names.push(entry.name);
    } catch {
      // Missing snapshots directory: no snapshots yet.
    }
    return names;
  },
  remove: async (p: string) => {
    try {
      await Deno.remove(p);
    } catch {
      // Already gone: nothing to clean.
    }
  },
};

/**
 * Migrate a pre-v3 handoff (v2 or legacy 1.x) into the canonical v3 model
 * before the save proceeds. Atomic: originals are backed up under
 * .handoff/history/migrations/<UTC-timestamp>/ and only replaced after every
 * temporary output validates; the config version upgrade renames last.
 * Returns the migration diagnostics (recorded in context.json), or null when
 * the handoff is already v3 or has no data.
 */
async function layoutOfDir(handoffDir: string): Promise<string> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(handoffDir)) files.push(entry.name);
  } catch {
    return "empty";
  }
  for (const sub of ["content", "views"]) {
    try {
      for await (const entry of Deno.readDir(join(handoffDir, sub))) files.push(`${sub}/${entry.name}`);
    } catch {
      // Subdirectory absent: not a v3 marker.
    }
  }
  return detectLayout(files);
}

async function migrateToV3(
  cwd: string,
  handoffDir: string,
): Promise<{ migration: string[]; conflicts: unknown[] } | null> {
  if ((await layoutOfDir(handoffDir)) === "v3") return null;
  const readIfExists = async (p: string): Promise<string | undefined> => {
    try {
      return await Deno.readTextFile(p);
    } catch {
      return undefined;
    }
  };
  const inputs = {
    config: await readIfExists(join(cwd, ".handoff.config.json")),
    contextJson: await readIfExists(join(handoffDir, "context.json")),
    handoffMd: await readIfExists(join(handoffDir, "HANDOFF.md")),
    tasksMd: await readIfExists(join(handoffDir, "tasks.md")),
    decisionsMd: await readIfExists(join(handoffDir, "decisions.md")),
    contextMapMd: await readIfExists(join(handoffDir, CONTEXT_MAP_FILE)),
  };
  const hasAnyInput = Object.entries(inputs)
    .filter(([key]) => key !== "config")
    .some(([, value]) => value != null);
  if (!hasAnyInput) return null;

  const plan = planV2ToV3Migration(inputs);
  if (!plan.needed) return null;

  const result = await applyV3Migration(
    migrationIo,
    plan,
    { handoffDir, configPath: join(cwd, ".handoff.config.json") },
  );
  console.log(`Previous handoff layout detected — migrated to Handoff Protocol v${V3_PROTOCOL_VERSION}.`);
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

  // Pre-v3 handoffs (v2 or legacy 1.x) migrate atomically into the canonical
  // v3 model before inference reconciles below.
  const migrationDiagnostics = await migrateToV3(cwd, handoffDir);

  const { name, language } = await readProjectInfo();
  const git = await getGitState();
  const modifiedFiles = await getModifiedFiles();
  const recentCommits = await getRecentCommits(config.commitCount);

  // Auto-analysis
  const todos = config.includeTodoScan ? await scanTodos(cwd) : [];
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

  const timestamp = new Date().toISOString();
  const agent = Deno.env.get("AGENT_NAME") || "opencode";

  // Verified project evidence becomes inference. Current Goal is never
  // inferred: commit messages (including release commits) describe history,
  // not goals — only an explicit user goal or an existing valid goal
  // populates that section.
  const inferred = buildInferredV3Sections({
    status,
    todos: todos.slice(0, config.maxTodos),
    nextSteps: [],
    decisions: [],
    risks,
    blockers: [],
    notes,
  });

  // Previous metadata supplies monotonic ID counters and view hashes.
  let previousJson: Record<string, unknown> | null = null;
  try {
    previousJson = JSON.parse(await Deno.readTextFile(join(handoffDir, "context.json")));
  } catch {
    // No readable previous context.json: counters recover from durable state.
  }

  // Reconcile the existing canonical state with fresh inference. User-owned
  // labels, bodies, hierarchy, and task states always win; IDs allocate only
  // for genuinely new semantic nodes. A present-but-invalid state aborts the
  // save rather than destroying user content.
  let existing = null;
  if (await exists(join(handoffDir, CONTEXT_MAP_FILE))) {
    existing = await loadHandoffState(migrationIo, handoffDir);
  }
  const reconciled = reconcileV3State({ existing, inferred, metadata: previousJson });
  const state = {
    version: V3_PROTOCOL_VERSION,
    map: reconciled.map,
    content: reconciled.content,
    diagnostics: reconciled.diagnostics,
  };

  // Manual edits to the generated view are overwritten, never imported. Warn
  // when the on-disk view no longer matches the hash stored by the last save.
  const storedViewHash = previousJson && (previousJson.hashes as Record<string, string> | undefined)?.["views/HANDOFF.md"];
  if (storedViewHash) {
    try {
      const current = await Deno.readTextFile(join(handoffDir, "views", "HANDOFF.md"));
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
  const files: Record<string, string> = {};
  for (const [file, content] of Object.entries(renderV3Files(state, metadata))) {
    files[file] = filterSensitive(content as string);
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
  } as never);
  // Counters are monotonic across deletions; the reconciled high-water marks
  // win over what a fresh recovery would observe.
  contextJson.idCounters = reconciled.counters;
  files["context.json"] = filterSensitive(JSON.stringify(contextJson, null, 2));

  await writeFilesAtomically(migrationIo, handoffDir, files);

  for (const diagnostic of reconciled.diagnostics) {
    console.error(`Note: ${diagnostic}`);
  }

  // Semantic snapshot: record the canonical state after a successful save.
  // Best-effort — a failed snapshot never fails the save.
  try {
    const snapshot = await writeV3Snapshot(state, { handoffDir }, snapshotIo);
    if (snapshot.written) console.log(`Snapshot: ${snapshot.path}`);
  } catch (err) {
    console.error(`Warning: snapshot failed: ${(err as Error).message}`);
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
  console.log(`Files: context-map.md, content/ (8 section files), views/HANDOFF.md, context.json`);
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
