#!/usr/bin/env -S deno run --allow-read --allow-run

/**
 * Handoff Protocol - Load Script
 *
 * Reads and analyzes handoff context from .handoff/ directory.
 *
 * Usage:
 *   deno run --allow-read --allow-run load.ts [mode]
 *
 * Modes:
 *   (default) - Standard read and summarize
 *   auto      - Auto-infer next steps with detailed analysis
 *   merge     - Merge with current git context
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { exists } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

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

interface LoadResult {
  understanding: string;
  nextActions: string[];
  risks: string[];
  pendingTasks: number;
  context: HandoffContext | null;
  storageMode: string;
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
  /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi,
  /gh[pousr]_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9\-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:secret|token|credential)\s*[:=]\s*["']?[a-zA-Z0-9\-._]{16,}["']?/gi,
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
  /(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|GCP_KEY)\s*[:=]\s*["']?[^\s"']+["']?/gi,
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

async function runCommand(cmd: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await command.output();
    return { stdout: new TextDecoder().decode(stdout).trim(), code };
  } catch {
    return { stdout: "", code: -1 };
  }
}

async function run(cmd: string[]): Promise<string> {
  const { stdout } = await runCommand(cmd);
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

async function ensureSubmoduleReady(cwd: string): Promise<boolean> {
  if (await isSubmoduleInitialized(cwd)) {
    const { code } = await runCommand(
      ["git", "submodule", "update", "--init", "--recursive", ".handoff"],
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

// ── Parsing ──────────────────────────────────────────────────────────────────

async function loadContextJson(handoffDir: string): Promise<HandoffContext | null> {
  const contextPath = join(handoffDir, "context.json");

  if (!await exists(contextPath)) {
    return null;
  }

  try {
    const content = await Deno.readTextFile(contextPath);
    const parsed = JSON.parse(content);

    if (!parsed.project || !parsed.timestamp) {
      console.error("Warning: context.json is missing required fields (project, timestamp)");
      return null;
    }

    return parsed as HandoffContext;
  } catch (err) {
    console.error(`Warning: Failed to parse context.json: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function parseHandoffMd(content: string): Partial<HandoffContext> {
  const result: Partial<HandoffContext> = {
    completed: [],
    modified_files: [],
    todos: [],
    blockers: [],
    next_steps: [],
    risks: [],
  };

  const lines = content.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)/);
    const numberedMatch = line.match(/^\d+\.\s+(.+)/);
    const item = bulletMatch?.[1] || numberedMatch?.[1];

    if (!item) continue;

    switch (currentSection) {
      case "current goal":
        if (!result.current_goal) result.current_goal = item;
        else result.current_goal += "\n" + item;
        break;
      case "current status":
        if (!result.status) result.status = item;
        break;
      case "completed work":
        result.completed!.push(item);
        break;
      case "modified files":
        const fileMatch = item.match(/`([^`]+)`/);
        if (fileMatch) {
          result.modified_files!.push({
            path: fileMatch[1],
            description: item,
            change_type: "modified",
          });
        }
        break;
      case "outstanding issues":
        result.blockers!.push(item);
        break;
      case "todo":
        const todoText = item.replace(/^\[[ x]\]\s*/, "");
        result.todos!.push({
          task: todoText,
          priority: "medium",
          status: item.includes("[x]") ? "completed" : "pending",
        });
        break;
      case "recommended next steps":
        result.next_steps!.push(item.replace(/^\d+\.\s*/, ""));
        break;
      case "risks / notes":
      case "risks":
        result.risks!.push(item);
        break;
    }
  }

  for (const line of lines.slice(0, 10)) {
    const projectMatch = line.match(/\*\*Project\*\*:\s*(.+)/);
    if (projectMatch) result.project = projectMatch[1].trim();

    const branchMatch = line.match(/\*\*Branch\*\*:\s*(.+)/);
    if (branchMatch) {
      result.git = {
        branch: branchMatch[1].trim(),
        latest_commit: "",
        commit_message: "",
        is_dirty: false,
      };
    }

    const goalMatch = line.match(/\*\*Goal\*\*:\s*(.+)/);
    if (goalMatch && !result.current_goal) result.current_goal = goalMatch[1].trim();
  }

  return result;
}

async function loadHandoffMd(handoffDir: string): Promise<string> {
  const mdPath = join(handoffDir, "HANDOFF.md");

  if (!await exists(mdPath)) {
    return "";
  }

  return await Deno.readTextFile(mdPath);
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function generateUnderstanding(ctx: HandoffContext): string {
  const parts: string[] = [];

  parts.push(`Project: ${ctx.project}`);
  parts.push(`Status: ${ctx.status}`);

  if (ctx.current_goal) {
    parts.push(`Goal: ${ctx.current_goal.split("\n")[0]}`);
  }

  if (ctx.completed.length > 0) {
    parts.push(`Completed: ${ctx.completed.length} items`);
  }

  if (ctx.git.branch !== "unknown") {
    parts.push(`Branch: ${ctx.git.branch}`);
  }

  const pendingTodos = ctx.todos.filter((t) => t.status === "pending");
  if (pendingTodos.length > 0) {
    parts.push(`Pending tasks: ${pendingTodos.length}`);
  }

  return parts.join(" | ");
}

function generateNextActions(ctx: HandoffContext, mode: string): string[] {
  const actions: string[] = [];

  if (ctx.next_steps.length > 0) {
    actions.push(...ctx.next_steps);
  }

  const highPriority = ctx.todos.filter(
    (t) => t.priority === "high" && t.status === "pending"
  );
  for (const todo of highPriority.slice(0, 2)) {
    actions.push(`[HIGH] ${todo.task}`);
  }

  if (ctx.blockers.length > 0) {
    actions.push(`Resolve blocker: ${ctx.blockers[0]}`);
  }

  if (mode === "auto") {
    if (ctx.modified_files.length > 0) {
      const addedFiles = ctx.modified_files.filter((f) => f.change_type === "added");
      const modifiedFiles = ctx.modified_files.filter((f) => f.change_type === "modified");

      if (addedFiles.length > 0) {
        actions.push(`Review ${addedFiles.length} newly added file(s)`);
      }
      if (modifiedFiles.length > 0) {
        actions.push(`Review changes to ${modifiedFiles.length} modified file(s)`);
      }
    }

    const mediumTodos = ctx.todos.filter(
      (t) => t.priority === "medium" && t.status === "pending"
    );
    if (mediumTodos.length > 0) {
      actions.push(`Address ${mediumTodos.length} medium-priority TODO items`);
    }

    if (ctx.git.is_dirty) {
      actions.push("Review and commit pending changes");
    }
  }

  if (actions.length === 0) {
    actions.push("Review current context and define next steps");
  }

  return actions.slice(0, 8);
}

function generateRisks(ctx: HandoffContext): string[] {
  const risks: string[] = [...ctx.risks];

  if (ctx.blockers.length > 0) {
    risks.push(`Active blocker: ${ctx.blockers[0]}`);
  }

  if (ctx.git.is_dirty) {
    risks.push("Uncommitted changes in working directory");
  }

  const pendingHigh = ctx.todos.filter(
    (t) => t.priority === "high" && t.status === "pending"
  );
  if (pendingHigh.length > 0) {
    risks.push(`${pendingHigh.length} high-priority task(s) pending`);
  }

  if (ctx.timestamp) {
    const savedTime = new Date(ctx.timestamp).getTime();
    const hoursSince = (Date.now() - savedTime) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      risks.push(`Handoff is ${Math.round(hoursSince)}h old - context may be stale`);
    }
  }

  return risks;
}

// ── Git Merge Analysis ───────────────────────────────────────────────────────

async function getCurrentGitState(): Promise<{
  branch: string;
  latestCommit: string;
  status: string;
}> {
  const [branch, latestCommit, status] = await Promise.all([
    run(["git", "branch", "--show-current"]),
    run(["git", "log", "-1", "--format=%h"]),
    run(["git", "status", "--porcelain"]),
  ]);

  return {
    branch: branch || "unknown",
    latestCommit: latestCommit || "unknown",
    status: status || "",
  };
}

async function analyzeMerge(
  ctx: HandoffContext,
  risks: string[],
  nextActions: string[]
): Promise<void> {
  const currentState = await getCurrentGitState();

  if (currentState.branch === "unknown") {
    risks.push("Git not available - cannot verify merge state");
    return;
  }

  if (currentState.branch !== ctx.git.branch) {
    risks.push(
      `Branch mismatch: handoff on '${ctx.git.branch}', current on '${currentState.branch}'`
    );
  }

  if (ctx.git.latest_commit && ctx.git.latest_commit !== "unknown") {
    const commitsSince = await run([
      "git", "rev-list", "--count", `${ctx.git.latest_commit}..HEAD`,
    ]);
    const count = parseInt(commitsSince);
    if (!isNaN(count) && count > 0) {
      nextActions.unshift(`Sync with ${count} new commit(s) since handoff`);

      const newCommits = await run([
        "git", "log", "--oneline", `${ctx.git.latest_commit}..HEAD`,
      ]);
      if (newCommits) {
        risks.push(`New commits since handoff:\n${newCommits}`);
      }
    }
  }

  if (currentState.status) {
    const changedFiles = currentState.status.split("\n").filter((l) => l.trim()).length;
    risks.push(`${changedFiles} file(s) have uncommitted changes`);
  }
}

// ── Output Formatting ────────────────────────────────────────────────────────

function formatOutput(result: LoadResult, mode: string): string {
  const lines: string[] = [];

  lines.push(`Storage: ${result.storageMode}`);
  lines.push("");
  lines.push("Current understanding:");
  lines.push(result.understanding);
  lines.push("");

  lines.push("Recommended next actions:");
  result.nextActions.forEach((action, i) => {
    lines.push(`${i + 1}. ${action}`);
  });
  lines.push("");

  if (result.risks.length > 0) {
    lines.push("Potential risks:");
    result.risks.forEach((risk) => {
      lines.push(`- ${risk}`);
    });
    lines.push("");
  }

  if (result.pendingTasks > 0) {
    lines.push(`Pending tasks: ${result.pendingTasks}`);
  }

  if (mode === "auto" && result.context) {
    lines.push("");
    lines.push("---");
    lines.push("Auto-analysis:");
    lines.push(`  Project: ${result.context.project}`);
    lines.push(`  Agent: ${result.context.agent}`);
    lines.push(`  Last saved: ${result.context.timestamp}`);
    lines.push(`  Modified files: ${result.context.modified_files.length}`);
    lines.push(`  Branch: ${result.context.git.branch}`);
  }

  return lines.join("\n");
}

// ── Main Load Logic ──────────────────────────────────────────────────────────

async function load(mode: string): Promise<LoadResult> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");

  // Read storage config
  const storageConfig = await readStorageConfig(cwd);
  const storageMode = storageConfig?.storage.mode || "direct";

  // Handle submodule mode
  if (storageMode === "submodule") {
    const ready = await ensureSubmoduleReady(cwd);
    if (!ready) {
      return {
        understanding: "Unable to access .handoff submodule.",
        nextActions: [
          "Check SSH key or GitHub credentials for the handoff repository",
          "Run: git submodule update --init --recursive .handoff",
        ],
        risks: ["Submodule access failed"],
        pendingTasks: 0,
        context: null,
        storageMode,
      };
    }
  }

  // Check .handoff/ exists
  if (!await exists(handoffDir)) {
    console.error("Error: No .handoff/ directory found.");
    console.error("Possible causes:");
    console.error("  1. Run `/handoff save` first to create context");
    console.error("  2. You may be in the wrong directory");
    console.error(`  3. Expected path: ${handoffDir}`);
    return {
      understanding: "No handoff context found.",
      nextActions: ["Run `/handoff save` to create context"],
      risks: ["No handoff directory"],
      pendingTasks: 0,
      context: null,
      storageMode,
    };
  }

  // Try loading context.json first
  let ctx = await loadContextJson(handoffDir);

  // Fallback: parse HANDOFF.md if context.json is missing/invalid
  if (!ctx) {
    console.error("Warning: context.json missing or invalid. Falling back to HANDOFF.md parsing.");

    const handoffMd = await loadHandoffMd(handoffDir);
    if (!handoffMd) {
      console.error("Error: Neither context.json nor HANDOFF.md found in .handoff/");
      console.error("Run `/handoff save` to regenerate both files.");
      return {
        understanding: "Handoff directory exists but contains no readable context.",
        nextActions: ["Run `/handoff save` to regenerate context"],
        risks: ["Invalid handoff state - no readable files"],
        pendingTasks: 0,
        context: null,
        storageMode,
      };
    }

    const parsed = parseHandoffMd(handoffMd);
    ctx = {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      agent: "unknown",
      project: parsed.project || "unknown",
      current_goal: parsed.current_goal || "",
      status: parsed.status || "unknown",
      completed: parsed.completed || [],
      modified_files: parsed.modified_files || [],
      todos: parsed.todos || [],
      blockers: parsed.blockers || [],
      decisions: parsed.decisions || [],
      next_steps: parsed.next_steps || [],
      git: parsed.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
      risks: parsed.risks || [],
      notes: "(parsed from HANDOFF.md - context.json was unavailable)",
    };

    console.error("Successfully parsed HANDOFF.md as fallback.");
  }

  const understanding = generateUnderstanding(ctx);
  const nextActions = generateNextActions(ctx, mode);
  const risks = generateRisks(ctx);
  const pendingTasks = ctx.todos.filter((t) => t.status === "pending").length;

  if (mode === "merge") {
    await analyzeMerge(ctx, risks, nextActions);
  }

  const sanitizedUnderstanding = filterSensitive(understanding);
  const sanitizedActions = nextActions.map((a) => filterSensitive(a));
  const sanitizedRisks = risks.map((r) => filterSensitive(r));

  return {
    understanding: sanitizedUnderstanding,
    nextActions: sanitizedActions,
    risks: sanitizedRisks,
    pendingTasks,
    context: ctx,
    storageMode,
  };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["default"] },
  });

  const mode = args._[0]?.toString() || "default";
  const validModes = ["default", "auto", "merge"];
  if (!validModes.includes(mode)) {
    console.error(`Error: Unknown mode '${mode}'`);
    console.error(`Valid modes: ${validModes.join(", ")}`);
    Deno.exit(1);
  }

  try {
    const result = await load(mode);
    console.log(formatOutput(result, mode));
  } catch (err) {
    console.error(`Error during load: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

main();
