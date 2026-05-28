#!/usr/bin/env -S deno run --allow-read --allow-run

/**
 * Handoff Protocol - Load Script
 * 
 * Enhanced load functionality for reading and analyzing handoff context.
 * 
 * Usage:
 *   deno run --allow-read --allow-run load.ts [mode]
 * 
 * Modes:
 *   (default) - Standard read and summarize
 *   auto      - Auto-infer next steps
 *   merge     - Merge with current context
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { exists } from "https://deno.land/std@0.224.0/fs/mod.ts";
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

interface LoadResult {
  understanding: string;
  nextActions: string[];
  risks: string[];
  pendingTasks: number;
  context: HandoffContext | null;
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

async function loadContext(handoffDir: string): Promise<HandoffContext | null> {
  const contextPath = join(handoffDir, "context.json");
  
  if (!await exists(contextPath)) {
    return null;
  }

  try {
    const content = await Deno.readTextFile(contextPath);
    return JSON.parse(content) as HandoffContext;
  } catch {
    return null;
  }
}

async function loadHandoffMd(handoffDir: string): Promise<string> {
  const mdPath = join(handoffDir, "HANDOFF.md");
  
  if (!await exists(mdPath)) {
    return "";
  }

  return await Deno.readTextFile(mdPath);
}

function generateUnderstanding(ctx: HandoffContext): string {
  const parts: string[] = [];
  
  parts.push(`Project: ${ctx.project}`);
  parts.push(`Status: ${ctx.status}`);
  
  if (ctx.current_goal) {
    parts.push(`Goal: ${ctx.current_goal}`);
  }
  
  if (ctx.completed.length > 0) {
    parts.push(`Completed: ${ctx.completed.length} tasks`);
  }
  
  if (ctx.git.branch !== "unknown") {
    parts.push(`Branch: ${ctx.git.branch}`);
  }

  return parts.join(" | ");
}

function generateNextActions(ctx: HandoffContext, mode: string): string[] {
  const actions: string[] = [];
  
  if (ctx.next_steps.length > 0) {
    actions.push(...ctx.next_steps);
  }
  
  if (ctx.todos.length > 0) {
    const highPriority = ctx.todos.filter((t) => t.priority === "high");
    if (highPriority.length > 0) {
      actions.push(`Complete high-priority task: ${highPriority[0].task}`);
    }
  }
  
  if (ctx.blockers.length > 0) {
    actions.push(`Address blocker: ${ctx.blockers[0]}`);
  }
  
  if (mode === "auto") {
    if (ctx.git.is_dirty) {
      actions.push("Review and commit pending changes");
    }
    
    if (ctx.modified_files.length > 0) {
      actions.push(`Review modified files: ${ctx.modified_files.map((f) => f.path).join(", ")}`);
    }
    
    const pendingTasks = ctx.todos.filter((t) => t.status === "pending");
    if (pendingTasks.length > 3) {
      actions.push(`Prioritize ${pendingTasks.length} pending tasks`);
    }
  }
  
  if (actions.length === 0) {
    actions.push("Review current context and define next steps");
  }
  
  return actions.slice(0, 5);
}

function generateRisks(ctx: HandoffContext): string[] {
  const risks: string[] = [];
  
  if (ctx.risks.length > 0) {
    risks.push(...ctx.risks);
  }
  
  if (ctx.blockers.length > 0) {
    risks.push(`Active blocker: ${ctx.blockers[0]}`);
  }
  
  if (ctx.git.is_dirty) {
    risks.push("Uncommitted changes in working directory");
  }
  
  const pendingHighPriority = ctx.todos.filter(
    (t) => t.priority === "high" && t.status === "pending"
  );
  if (pendingHighPriority.length > 0) {
    risks.push(`${pendingHighPriority.length} high-priority tasks pending`);
  }
  
  return risks;
}

async function getCurrentGitState(): Promise<{
  branch: string;
  latestCommit: string;
  status: string;
}> {
  const [branch, latestCommit, status] = await Promise.all([
    runCommand(["git", "branch", "--show-current"]),
    runCommand(["git", "log", "-1", "--format=%h"]),
    runCommand(["git", "status", "--porcelain"]),
  ]);

  return {
    branch: branch || "unknown",
    latestCommit: latestCommit || "unknown",
    status: status || "",
  };
}

async function load(mode: string): Promise<LoadResult> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");

  if (!await exists(handoffDir)) {
    return {
      understanding: "No handoff context found. Run `/handoff save` first.",
      nextActions: ["Run `/handoff save` to create context"],
      risks: [],
      pendingTasks: 0,
      context: null,
    };
  }

  const [ctx, handoffMd] = await Promise.all([
    loadContext(handoffDir),
    loadHandoffMd(handoffDir),
  ]);

  if (!ctx) {
    return {
      understanding: "Handoff directory exists but context.json is missing or invalid.",
      nextActions: ["Run `/handoff save` to regenerate context"],
      risks: ["Invalid handoff state"],
      pendingTasks: 0,
      context: null,
    };
  }

  const understanding = generateUnderstanding(ctx);
  const nextActions = generateNextActions(ctx, mode);
  const risks = generateRisks(ctx);
  const pendingTasks = ctx.todos.filter((t) => t.status === "pending").length;

  if (mode === "merge") {
    const currentState = await getCurrentGitState();
    
    if (currentState.branch !== ctx.git.branch) {
      risks.push(`Branch mismatch: handoff on ${ctx.git.branch}, current on ${currentState.branch}`);
    }
    
    if (currentState.latestCommit !== ctx.git.latest_commit) {
      const commitsSince = await runCommand([
        "git",
        "rev-list",
        "--count",
        `${ctx.git.latest_commit}..HEAD`,
      ]);
      if (commitsSince && parseInt(commitsSince) > 0) {
        nextActions.unshift(`Sync with ${commitsSince} new commits since handoff`);
      }
    }
  }

  return {
    understanding,
    nextActions,
    risks,
    pendingTasks,
    context: ctx,
  };
}

function formatOutput(result: LoadResult): string {
  const lines: string[] = [];
  
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
  
  return lines.join("\n");
}

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["default"] },
  });

  const mode = args._[0]?.toString() || "default";
  const result = await load(mode);
  
  console.log(formatOutput(result));
}

main();
