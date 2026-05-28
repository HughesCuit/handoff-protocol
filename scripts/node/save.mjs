#!/usr/bin/env node

/**
 * Handoff Protocol - Save Script (Node.js Reference Implementation)
 *
 * Usage:
 *   node save.mjs [mode]
 *
 * Modes:
 *   (default) - Standard save
 *   compact   - Minimal summary
 *   full      - Maximum context
 *   diff      - Focus on changes
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

/** @typedef {{ path: string; description: string; change_type: string }} ModifiedFile */
/** @typedef {{ task: string; priority: string; status: string }} TodoItem */
/** @typedef {{ title: string; context: string; decision: string; rationale: string }} Decision */

/**
 * @typedef {Object} HandoffContext
 * @property {string} version
 * @property {string} timestamp
 * @property {string} agent
 * @property {string} project
 * @property {string} current_goal
 * @property {string} status
 * @property {string[]} completed
 * @property {ModifiedFile[]} modified_files
 * @property {TodoItem[]} todos
 * @property {string[]} blockers
 * @property {Decision[]} decisions
 * @property {string[]} next_steps
 * @property {{ branch: string; latest_commit: string; commit_message: string; is_dirty: boolean }} git
 * @property {string[]} risks
 * @property {string} notes
 */

// ── Security ─────────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
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

// ── Git Functions ────────────────────────────────────────────────────────────

function getGitState() {
  const branch = runCommand("git branch --show-current");
  const latestCommit = runCommand("git log -1 --format=%h");
  const commitMessage = runCommand("git log -1 --format=%s");
  const status = runCommand("git status --porcelain");

  return {
    branch: branch || "unknown",
    latest_commit: latestCommit || "unknown",
    commit_message: filterSensitive(commitMessage || ""),
    is_dirty: status.length > 0,
  };
}

function getModifiedFiles() {
  const status = runCommand("git status --porcelain");
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

function getRecentCommits(count = 5) {
  const log = runCommand(`git log --oneline -n ${count}`);
  if (!log) return [];
  return log.split("\n").filter((line) => line.trim());
}

function getDiffSummary() {
  return runCommand("git diff --shortstat") ||
    runCommand("git diff --shortstat --cached") || "";
}

// ── Auto-Analysis ────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".handoff", "dist", "build", "vendor", "__pycache__",
]);

function scanTodos(dir, maxFiles = 200) {
  const todos = [];
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s]+(.+)/gi;
  let fileCount = 0;

  function walkDir(currentDir) {
    if (++fileCount > maxFiles) return;

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (fileCount > maxFiles) break;

      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walkDir(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          let match;
          todoPattern.lastIndex = 0;
          while ((match = todoPattern.exec(lines[i])) !== null) {
            const tag = match[1].toUpperCase();
            const task = match[2].trim();
            const priority = (tag === "FIXME" || tag === "HACK") ? "high" : "medium";
            const relPath = relative(dir, fullPath);
            todos.push({
              task: `${task} (${relPath}:${i + 1})`,
              priority,
              status: "pending",
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  walkDir(dir);
  return todos.slice(0, 20);
}

function inferGoalFromCommits(commits) {
  if (commits.length === 0) return "";
  return commits[0].replace(/^[a-f0-9]+\s+/, "");
}

function inferCompletedFromCommits(commits) {
  return commits.slice(1, 6).map((c) => c.replace(/^[a-f0-9]+\s+/, ""));
}

function inferStatusFromGit(git, modifiedFiles) {
  if (modifiedFiles.length === 0) return "idle - no pending changes";
  if (git.is_dirty) return `in-progress - ${modifiedFiles.length} file(s) modified`;
  return "ready - changes committed";
}

function inferRisksFromState(git, todos, modifiedFiles) {
  const risks = [];

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

function readProjectInfo() {
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
      const content = readFileSync(file, "utf-8");
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

function generateHandoffMarkdown(ctx) {
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

function generateTasksMarkdown(ctx) {
  const high = ctx.todos.filter((t) => t.priority === "high");
  const medium = ctx.todos.filter((t) => t.priority === "medium");
  const low = ctx.todos.filter((t) => t.priority === "low");

  const fmt = (tasks) => tasks.map((t) => `- [ ] ${t.task}`).join("\n") || "None";

  return `# Pending Tasks

## High Priority
${fmt(high)}

## Medium Priority
${fmt(medium)}

## Low Priority
${fmt(low)}
`;
}

function generateDecisionsMarkdown(ctx) {
  if (ctx.decisions.length === 0) {
    return "# Architecture Decisions\n\nNo decisions recorded.\n";
  }

  const decisions = ctx.decisions
    .map((d) => `## ${d.title}\n\n- **Context**: ${d.context || "N/A"}\n- **Decision**: ${d.decision}\n- **Rationale**: ${d.rationale || "N/A"}`)
    .join("\n\n");

  return `# Architecture Decisions\n\n${decisions}\n`;
}

// ── Mode Handling ────────────────────────────────────────────────────────────

function getModeConfig(mode) {
  switch (mode) {
    case "compact":
      return { commitCount: 3, maxTodos: 5, includeDiffStat: false, includeRiskAnalysis: false, includeTodoScan: false };
    case "full":
      return { commitCount: 20, maxTodos: 50, includeDiffStat: true, includeRiskAnalysis: true, includeTodoScan: true };
    case "diff":
      return { commitCount: 5, maxTodos: 10, includeDiffStat: true, includeRiskAnalysis: false, includeTodoScan: false };
    default:
      return { commitCount: 5, maxTodos: 20, includeDiffStat: true, includeRiskAnalysis: true, includeTodoScan: true };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function save(mode) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");
  const config = getModeConfig(mode);

  const gitAvailable = !!runCommand("git --version");
  if (!gitAvailable) {
    console.error("Error: git is not available. Falling back to file-scan mode.");
  }

  mkdirSync(handoffDir, { recursive: true });

  const { name, language } = readProjectInfo();
  const git = getGitState();
  const modifiedFiles = getModifiedFiles();
  const recentCommits = getRecentCommits(config.commitCount);

  const todos = config.includeTodoScan ? scanTodos(cwd) : [];
  const inferredGoal = inferGoalFromCommits(recentCommits);
  const completed = inferCompletedFromCommits(recentCommits);
  const status = inferStatusFromGit(git, modifiedFiles);
  const risks = config.includeRiskAnalysis ? inferRisksFromState(git, todos, modifiedFiles) : [];

  let notes = recentCommits.join("\n");
  if (config.includeDiffStat) {
    const diffSummary = getDiffSummary();
    if (diffSummary) notes = `Diff summary: ${diffSummary}\n\n${notes}`;
  }

  /** @type {HandoffContext} */
  const ctx = {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    agent: process.env.AGENT_NAME || "opencode",
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

  writeFileSync(join(handoffDir, "HANDOFF.md"), filterSensitive(handoffMd));
  writeFileSync(join(handoffDir, "context.json"), filterSensitive(contextJson));
  writeFileSync(join(handoffDir, "tasks.md"), filterSensitive(tasksMd));
  writeFileSync(join(handoffDir, "decisions.md"), filterSensitive(decisionsMd));

  console.log(`Handoff saved to ${handoffDir}`);
  console.log(`Mode: ${mode}`);
  console.log(`Project: ${name} (${language})`);
  console.log(`Goal: ${inferredGoal || "(inferred from commits)"}`);
  console.log(`Files: HANDOFF.md, context.json, tasks.md, decisions.md`);
  if (todos.length > 0) console.log(`Scanned: ${todos.length} TODO/FIXME items found`);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || "default";
const validModes = ["default", "compact", "full", "diff"];
if (!validModes.includes(mode)) {
  console.error(`Error: Unknown mode '${mode}'`);
  console.error(`Valid modes: ${validModes.join(", ")}`);
  process.exit(1);
}

try {
  save(mode);
} catch (err) {
  console.error(`Error during save: ${err.message}`);
  process.exit(1);
}
