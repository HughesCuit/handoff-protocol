#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run

/**
 * Handoff Protocol - Save Script
 * 
 * Enhanced save functionality for collecting and writing handoff context.
 * 
 * Usage:
 *   deno run --allow-read --allow-write --allow-run save.ts [mode]
 * 
 * Modes:
 *   (default) - Standard save
 *   compact   - Minimal summary
 *   full      - Maximum context
 *   diff      - Focus on changes
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

interface HandoffContext {
  version: string;
  timestamp: string;
  agent: string;
  project: string;
  current_goal: string;
  status: string;
  completed: string[];
  modified_files: Array<{
    path: string;
    description: string;
    change_type: string;
  }>;
  todos: Array<{
    task: string;
    priority: string;
    status: string;
  }>;
  blockers: string[];
  decisions: Array<{
    title: string;
    context: string;
    decision: string;
    rationale: string;
  }>;
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

const SENSITIVE_PATTERNS = [
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{20,}/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /cookie\s*:\s*[^\n]+/gi,
  /password\s*[:=]\s*["']?[^\s"']+/gi,
  /private[_-]?key\s*[:=]\s*-----BEGIN/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
  /[a-zA-Z0-9+/]{40,}={0,2}/g,
];

function filterSensitive(text: string): string {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, "[REDACTED]");
  }
  return filtered;
}

async function runCommand(cmd: string[]): Promise<string> {
  try {
    const process = Deno.run({
      cmd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await process.status();
    if (code !== 0) return "";
    const output = await process.output();
    return new TextDecoder().decode(output).trim();
  } catch {
    return "";
  }
}

async function getGitState(): Promise<HandoffContext["git"]> {
  const [branch, latestCommit, commitMessage, status] = await Promise.all([
    runCommand(["git", "branch", "--show-current"]),
    runCommand(["git", "log", "-1", "--format=%h"]),
    runCommand(["git", "log", "-1", "--format=%s"]),
    runCommand(["git", "status", "--porcelain"]),
  ]);

  return {
    branch: branch || "unknown",
    latest_commit: latestCommit || "unknown",
    commit_message: filterSensitive(commitMessage || ""),
    is_dirty: status.length > 0,
  };
}

async function getModifiedFiles(): Promise<HandoffContext["modified_files"]> {
  const status = await runCommand(["git", "status", "--porcelain"]);
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
      else if (statusCode === "R") changeType = "renamed";
      return { path, description: "", change_type: changeType };
    });
}

async function getRecentCommits(count: number = 5): Promise<string[]> {
  const log = await runCommand([
    "git",
    "log",
    `--oneline`,
    `-n`,
    count.toString(),
  ]);
  if (!log) return [];
  return log.split("\n").filter((line) => line.trim());
}

async function readProjectInfo(): Promise<{ name: string; language: string }> {
  const files = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  for (const file of files) {
    try {
      const content = await Deno.readTextFile(file);
      if (file === "package.json") {
        const pkg = JSON.parse(content);
        return { name: pkg.name || "unknown", language: "typescript/javascript" };
      }
      if (file === "Cargo.toml") {
        const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
        return { name: nameMatch?.[1] || "unknown", language: "rust" };
      }
      if (file === "go.mod") {
        const nameMatch = content.match(/module\s+(.+)/);
        return { name: nameMatch?.[1]?.split("/").pop() || "unknown", language: "go" };
      }
      if (file === "pyproject.toml") {
        const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
        return { name: nameMatch?.[1] || "unknown", language: "python" };
      }
    } catch {
      continue;
    }
  }
  return { name: "unknown", language: "unknown" };
}

function generateHandoffMarkdown(ctx: HandoffContext): string {
  const completed = ctx.completed.map((item) => `- ${item}`).join("\n");
  const modified = ctx.modified_files
    .map((f) => `- \`${f.path}\` - ${f.description || f.change_type}`)
    .join("\n");
  const todos = ctx.todos.map((t) => `- [ ] ${t.task}`).join("\n");
  const blockers = ctx.blockers.map((b) => `- ${b}`).join("\n");
  const nextSteps = ctx.next_steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const risks = ctx.risks.map((r) => `- ${r}`).join("\n");

  return `# Project Handoff

**Saved**: ${ctx.timestamp}
**Agent**: ${ctx.agent}
**Branch**: ${ctx.git.branch}

## Current Goal

${ctx.current_goal}

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

  const formatTasks = (tasks: typeof ctx.todos) =>
    tasks.map((t) => `- [ ] ${t.task}`).join("\n");

  return `# Pending Tasks

## High Priority
${formatTasks(high) || "None"}

## Medium Priority
${formatTasks(medium) || "None"}

## Low Priority
${formatTasks(low) || "None"}
`;
}

function generateDecisionsMarkdown(ctx: HandoffContext): string {
  if (ctx.decisions.length === 0) {
    return "# Architecture Decisions\n\nNo decisions recorded.";
  }

  const decisions = ctx.decisions
    .map(
      (d) => `## ${d.title}

- **Context**: ${d.context || "N/A"}
- **Decision**: ${d.decision}
- **Rationale**: ${d.rationale || "N/A"}
`
    )
    .join("\n");

  return `# Architecture Decisions

${decisions}`;
}

async function save(mode: string): Promise<void> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");

  await ensureDir(handoffDir);

  const { name, language } = await readProjectInfo();
  const git = await getGitState();
  const modifiedFiles = await getModifiedFiles();
  const recentCommits = await getRecentCommits(mode === "full" ? 20 : 5);

  const ctx: HandoffContext = {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    agent: Deno.env.get("AGENT_NAME") || "opencode",
    project: name,
    current_goal: "",
    status: "in-progress",
    completed: [],
    modified_files: modifiedFiles,
    todos: [],
    blockers: [],
    decisions: [],
    next_steps: [],
    git,
    risks: [],
    notes: recentCommits.join("\n"),
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

  console.log(`Handoff saved to ${handoffDir}`);
  console.log(`Mode: ${mode}`);
  console.log(`Files: HANDOFF.md, context.json, tasks.md, decisions.md`);
}

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["save"] },
  });

  const mode = args._[0] || "default";
  await save(mode.toString());
}

main();
