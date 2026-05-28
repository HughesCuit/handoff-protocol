#!/usr/bin/env node

/**
 * Handoff Protocol - Load Script (Node.js Reference Implementation)
 *
 * Usage:
 *   node load.mjs [mode]
 *
 * Modes:
 *   (default) - Standard read and summarize
 *   auto      - Auto-infer next steps
 *   merge     - Merge with current git context
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Security ─────────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
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
];

function filterSensitive(text) {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, "[REDACTED]");
  }
  return filtered;
}

// ── Command Execution ────────────────────────────────────────────────────────

function runCommand(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function loadContextJson(handoffDir) {
  const contextPath = join(handoffDir, "context.json");

  if (!existsSync(contextPath)) {
    return null;
  }

  try {
    const content = readFileSync(contextPath, "utf-8");
    const parsed = JSON.parse(content);

    if (!parsed.project || !parsed.timestamp) {
      console.error("Warning: context.json is missing required fields (project, timestamp)");
      return null;
    }

    return parsed;
  } catch (err) {
    console.error(`Warning: Failed to parse context.json: ${err.message}`);
    return null;
  }
}

function parseHandoffMd(content) {
  const result = {
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
        result.completed.push(item);
        break;
      case "modified files":
        const fileMatch = item.match(/`([^`]+)`/);
        if (fileMatch) {
          result.modified_files.push({
            path: fileMatch[1],
            description: item,
            change_type: "modified",
          });
        }
        break;
      case "outstanding issues":
        result.blockers.push(item);
        break;
      case "todo":
        const todoText = item.replace(/^\[[ x]\]\s*/, "");
        result.todos.push({
          task: todoText,
          priority: "medium",
          status: item.includes("[x]") ? "completed" : "pending",
        });
        break;
      case "recommended next steps":
        result.next_steps.push(item.replace(/^\d+\.\s*/, ""));
        break;
      case "risks / notes":
      case "risks":
        result.risks.push(item);
        break;
    }
  }

  // Extract metadata from header
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
  }

  return result;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function generateUnderstanding(ctx) {
  const parts = [];

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

function generateNextActions(ctx, mode) {
  const actions = [];

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

      if (addedFiles.length > 0) actions.push(`Review ${addedFiles.length} newly added file(s)`);
      if (modifiedFiles.length > 0) actions.push(`Review changes to ${modifiedFiles.length} modified file(s)`);
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

function generateRisks(ctx) {
  const risks = [...ctx.risks];

  if (ctx.blockers.length > 0) risks.push(`Active blocker: ${ctx.blockers[0]}`);
  if (ctx.git.is_dirty) risks.push("Uncommitted changes in working directory");

  const pendingHigh = ctx.todos.filter(
    (t) => t.priority === "high" && t.status === "pending"
  );
  if (pendingHigh.length > 0) risks.push(`${pendingHigh.length} high-priority task(s) pending`);

  if (ctx.timestamp) {
    const savedTime = new Date(ctx.timestamp).getTime();
    const hoursSince = (Date.now() - savedTime) / (1000 * 60 * 60);
    if (hoursSince > 24) {
      risks.push(`Handoff is ${Math.round(hoursSince)}h old - context may be stale`);
    }
  }

  return risks;
}

// ── Merge Analysis ───────────────────────────────────────────────────────────

function analyzeMerge(ctx, risks, nextActions) {
  const branch = runCommand("git branch --show-current");
  const latestCommit = runCommand("git log -1 --format=%h");
  const status = runCommand("git status --porcelain");

  if (!branch) {
    risks.push("Git not available - cannot verify merge state");
    return;
  }

  if (branch !== ctx.git.branch) {
    risks.push(`Branch mismatch: handoff on '${ctx.git.branch}', current on '${branch}'`);
  }

  if (ctx.git.latest_commit && ctx.git.latest_commit !== "unknown") {
    const commitsSince = runCommand(`git rev-list --count ${ctx.git.latest_commit}..HEAD`);
    const count = parseInt(commitsSince);
    if (!isNaN(count) && count > 0) {
      nextActions.unshift(`Sync with ${count} new commit(s) since handoff`);

      const newCommits = runCommand(`git log --oneline ${ctx.git.latest_commit}..HEAD`);
      if (newCommits) {
        risks.push(`New commits since handoff:\n${newCommits}`);
      }
    }
  }

  if (status) {
    const changedFiles = status.split("\n").filter((l) => l.trim()).length;
    risks.push(`${changedFiles} file(s) have uncommitted changes`);
  }
}

// ── Output Formatting ────────────────────────────────────────────────────────

function formatOutput(result, mode) {
  const lines = [];

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

// ── Main ─────────────────────────────────────────────────────────────────────

function load(mode) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");

  if (!existsSync(handoffDir)) {
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
    };
  }

  let ctx = loadContextJson(handoffDir);

  // Fallback to HANDOFF.md
  if (!ctx) {
    console.error("Warning: context.json missing or invalid. Falling back to HANDOFF.md parsing.");

    const mdPath = join(handoffDir, "HANDOFF.md");
    if (!existsSync(mdPath)) {
      console.error("Error: Neither context.json nor HANDOFF.md found in .handoff/");
      console.error("Run `/handoff save` to regenerate both files.");
      return {
        understanding: "Handoff directory exists but contains no readable context.",
        nextActions: ["Run `/handoff save` to regenerate context"],
        risks: ["Invalid handoff state - no readable files"],
        pendingTasks: 0,
        context: null,
      };
    }

    const content = readFileSync(mdPath, "utf-8");
    const parsed = parseHandoffMd(content);
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
    analyzeMerge(ctx, risks, nextActions);
  }

  return {
    understanding: filterSensitive(understanding),
    nextActions: nextActions.map((a) => filterSensitive(a)),
    risks: risks.map((r) => filterSensitive(r)),
    pendingTasks,
    context: ctx,
  };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || "default";
const validModes = ["default", "auto", "merge"];
if (!validModes.includes(mode)) {
  console.error(`Error: Unknown mode '${mode}'`);
  console.error(`Valid modes: ${validModes.join(", ")}`);
  process.exit(1);
}

try {
  const result = load(mode);
  console.log(formatOutput(result, mode));
} catch (err) {
  console.error(`Error during load: ${err.message}`);
  process.exit(1);
}
