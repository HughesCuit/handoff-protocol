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
 * Storage modes (configured via .handoff.config.json):
 *   direct    - .handoff/ as local directory
 *   submodule - .handoff/ as git submodule
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { ensureDir, walk, exists } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join, extname } from "https://deno.land/std@0.224.0/path/mod.ts";

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

const SENSITIVE_PATTERNS: RegExp[] = [
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9\-]{16,}["']?/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*/gi,
  /cookie\s*:\s*[^\n]+/gi,
  /password\s*[:=]\s*["']?[^\s"']+["']?/gi,
  /private[_-]?key\s*[:=]\s*-----BEGIN/gi,
  /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  /gh[pousr]_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9\-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:secret|token|credential)\s*[:=]\s*["']?[a-zA-Z0-9\-._]{16,}["']?/gi,
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@[^\s"']+["']?/gi,
  /(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|GCP_KEY)\s*[:=]\s*["']?[^\s"']+["']?/gi,
  /(?:xox[bpsa]-[a-zA-Z0-9-]+)/g,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
];

function filterSensitive(text: string): string {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, "[REDACTED]");
  }
  return filtered;
}

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
  const files = ["HANDOFF.md", "context.json", "tasks.md", "decisions.md"];

  for (const file of files) {
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
      version: "1.1.0",
      storage: { mode: "direct", path: ".handoff" },
    };
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
      version: "1.1.0",
      storage: { mode: "submodule", path: ".handoff", remote: remoteUrl },
    };
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

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

async function scanTodos(cwd: string): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s]+(.+)/gi;
  let fileCount = 0;
  const maxFiles = 200;

  try {
    for await (const entry of walk(cwd, { skip: [/node_modules/, /\.git/, /\.handoff/, /dist/, /build/, /vendor/, /__pycache__/] })) {
      if (!entry.isFile) continue;
      if (!SOURCE_EXTENSIONS.has(extname(entry.path))) continue;
      if (++fileCount > maxFiles) break;

      try {
        const content = await Deno.readTextFile(entry.path);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const match = todoPattern.exec(lines[i]);
          if (match) {
            const tag = match[1].toUpperCase();
            const task = match[2].trim();
            const priority = tag === "FIXME" ? "high" : tag === "HACK" ? "high" : "medium";
            const relPath = entry.path.replace(cwd + "/", "");
            todos.push({
              task: `${task} (${relPath}:${i + 1})`,
              priority,
              status: "pending",
            });
          }
          todoPattern.lastIndex = 0;
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

// ── Markdown Generation ──────────────────────────────────────────────────────

function generateHandoffMarkdown(ctx: HandoffContext): string {
  const completed = ctx.completed.map((item) => `- ${item}`).join("\n");
  const modified = ctx.modified_files
    .map((f) => `- \`${f.path}\` [${f.change_type}]`)
    .join("\n");
  const todos = ctx.todos.map((t) => `- [ ] **${t.priority}** ${t.task}`).join("\n");
  const blockers = ctx.blockers.map((b) => `- ${b}`).join("\n");
  const nextSteps = ctx.next_steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const risks = ctx.risks.map((r) => `- ${r}`).join("\n");

  return `# Project Handoff

**Saved**: ${ctx.timestamp}
**Agent**: ${ctx.agent}
**Project**: ${ctx.project}
**Branch**: ${ctx.git.branch}
**Commit**: ${ctx.git.latest_commit} - ${ctx.git.commit_message}

## Current Goal

${ctx.current_goal || "No explicit goal set."}

## Current Status

${ctx.status}

## Completed Work

${completed || "No completed work recorded."}

## Modified Files

${modified || "No files modified."}

## Outstanding Issues

${blockers || "No blockers."}

## TODO

${todos || "No pending tasks."}

## Recommended Next Steps

${nextSteps || "No next steps defined."}

## Risks / Notes

${risks || "No risks identified."}

---

*Generated by Handoff Protocol v${ctx.version}*
`;
}

function generateTasksMarkdown(ctx: HandoffContext): string {
  const high = ctx.todos.filter((t) => t.priority === "high");
  const medium = ctx.todos.filter((t) => t.priority === "medium");
  const low = ctx.todos.filter((t) => t.priority === "low");

  const fmt = (tasks: TodoItem[]) =>
    tasks.map((t) => `- [ ] ${t.task}`).join("\n") || "None";

  return `# Pending Tasks

## High Priority
${fmt(high)}

## Medium Priority
${fmt(medium)}

## Low Priority
${fmt(low)}
`;
}

function generateDecisionsMarkdown(ctx: HandoffContext): string {
  if (ctx.decisions.length === 0) {
    return "# Architecture Decisions\n\nNo decisions recorded.\n";
  }

  const decisions = ctx.decisions
    .map((d) => `## ${d.title}

- **Context**: ${d.context || "N/A"}
- **Decision**: ${d.decision}
- **Rationale**: ${d.rationale || "N/A"}`)
    .join("\n\n");

  return `# Architecture Decisions\n\n${decisions}\n`;
}

// ── Mode Handling ────────────────────────────────────────────────────────────

interface ModeConfig {
  commitCount: number;
  maxTodos: number;
  includeDiffStat: boolean;
  includeRiskAnalysis: boolean;
  includeTodoScan: boolean;
}

function getModeConfig(mode: string): ModeConfig {
  switch (mode) {
    case "compact":
      return {
        commitCount: 3,
        maxTodos: 5,
        includeDiffStat: false,
        includeRiskAnalysis: false,
        includeTodoScan: false,
      };
    case "full":
      return {
        commitCount: 20,
        maxTodos: 50,
        includeDiffStat: true,
        includeRiskAnalysis: true,
        includeTodoScan: true,
      };
    case "diff":
      return {
        commitCount: 5,
        maxTodos: 10,
        includeDiffStat: true,
        includeRiskAnalysis: false,
        includeTodoScan: false,
      };
    default: // standard
      return {
        commitCount: 5,
        maxTodos: 20,
        includeDiffStat: true,
        includeRiskAnalysis: true,
        includeTodoScan: true,
      };
  }
}

// ── Main Save Logic ──────────────────────────────────────────────────────────

async function save(mode: string): Promise<void> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");
  const config = getModeConfig(mode);

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
  }

  const storageMode = storageConfig.storage.mode;

  // Ensure .handoff is ready based on storage mode
  if (storageMode === "submodule") {
    const ready = await ensureSubmoduleReady(cwd);
    if (!ready) Deno.exit(1);
  } else {
    await ensureDir(handoffDir);
  }

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
    version: "1.1.0",
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
  };

  const handoffMd = generateHandoffMarkdown(ctx);
  const tasksMd = generateTasksMarkdown(ctx);
  const decisionsMd = generateDecisionsMarkdown(ctx);
  const contextJson = JSON.stringify(ctx, null, 2);

  await Promise.all([
    Deno.writeTextFile(join(handoffDir, "HANDOFF.md"), filterSensitive(handoffMd)),
    Deno.writeTextFile(join(handoffDir, "context.json"), filterSensitive(contextJson)),
    Deno.writeTextFile(join(handoffDir, "tasks.md"), filterSensitive(tasksMd)),
    Deno.writeTextFile(join(handoffDir, "decisions.md"), filterSensitive(decisionsMd)),
  ]);

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
  console.log(`Project: ${name} (${language})`);
  console.log(`Goal: ${inferredGoal || "(inferred from commits)"}`);
  console.log(`Files: HANDOFF.md, context.json, tasks.md, decisions.md`);
  if (todos.length > 0) {
    console.log(`Scanned: ${todos.length} TODO/FIXME items found`);
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["save"] },
  });

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
    console.log("Handoff storage:");
    console.log(`  mode: ${config.storage.mode}`);
    console.log(`  path: ${config.storage.path}`);
    if (config.storage.remote) {
      console.log(`  remote: ${config.storage.remote}`);
    }
    return;
  }

  // Handle save with mode
  const mode = subcommand;
  const validModes = ["default", "compact", "full", "diff"];
  if (!validModes.includes(mode)) {
    console.error(`Error: Unknown mode '${mode}'`);
    console.error(`Valid modes: ${validModes.join(", ")}`);
    Deno.exit(1);
  }

  try {
    await save(mode);
  } catch (err) {
    console.error(`Error during save: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

main();
