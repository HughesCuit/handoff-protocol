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
  /(?:sk-[a-zA-Z0-9]{20,})/g,
];

function filterSensitive(text) {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) filtered = filtered.replace(pattern, "[REDACTED]");
  return filtered;
}

function runCommand(cmd, opts) {
  try { return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim(); }
  catch { return ""; }
}

// ── Storage Config ───────────────────────────────────────────────────────────

function readStorageConfig(cwd) {
  try {
    const config = JSON.parse(readFileSync(join(cwd, ".handoff.config.json"), "utf-8"));
    return config.storage?.mode ? config : null;
  } catch { return null; }
}

function isSubmoduleInitialized(cwd) {
  try { return readFileSync(join(cwd, ".gitmodules"), "utf-8").includes(".handoff"); }
  catch { return false; }
}

function ensureSubmoduleReady(cwd) {
  if (isSubmoduleInitialized(cwd)) {
    runCommand("git submodule update --init --recursive .handoff");
    return true;
  }
  console.error("Error: .handoff is not registered as a submodule.");
  console.error("Run `/handoff init submodule` first.");
  return false;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function loadContextJson(handoffDir) {
  const contextPath = join(handoffDir, "context.json");
  if (!existsSync(contextPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf-8"));
    if (!parsed.project || !parsed.timestamp) return null;
    return parsed;
  } catch { return null; }
}

function parseHandoffMd(content) {
  const result = { completed: [], modified_files: [], todos: [], blockers: [], next_steps: [], risks: [] };
  const lines = content.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const sm = line.match(/^##\s+(.+)/);
    if (sm) { currentSection = sm[1].trim().toLowerCase(); continue; }
    const bm = line.match(/^-\s+(.+)/);
    const nm = line.match(/^\d+\.\s+(.+)/);
    const item = bm?.[1] || nm?.[1];
    if (!item) continue;

    switch (currentSection) {
      case "current goal": if (!result.current_goal) result.current_goal = item; break;
      case "current status": if (!result.status) result.status = item; break;
      case "completed work": result.completed.push(item); break;
      case "modified files": { const fm = item.match(/`([^`]+)`/); if (fm) result.modified_files.push({ path: fm[1], description: item, change_type: "modified" }); break; }
      case "outstanding issues": result.blockers.push(item); break;
      case "todo": result.todos.push({ task: item.replace(/^\[[ x]\]\s*/, ""), priority: "medium", status: item.includes("[x]") ? "completed" : "pending" }); break;
      case "recommended next steps": result.next_steps.push(item.replace(/^\d+\.\s*/, "")); break;
      case "risks / notes": case "risks": result.risks.push(item); break;
    }
  }

  for (const line of lines.slice(0, 10)) {
    const pm = line.match(/\*\*Project\*\*:\s*(.+)/);
    if (pm) result.project = pm[1].trim();
    const bm = line.match(/\*\*Branch\*\*:\s*(.+)/);
    if (bm) result.git = { branch: bm[1].trim(), latest_commit: "", commit_message: "", is_dirty: false };
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function load(mode) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");
  const storageConfig = readStorageConfig(cwd);
  const storageMode = storageConfig?.storage.mode || "direct";

  if (storageMode === "submodule" && !ensureSubmoduleReady(cwd)) {
    return { understanding: "Unable to access .handoff submodule.", nextActions: ["Check SSH key or credentials", "Run: git submodule update --init --recursive .handoff"], risks: ["Submodule access failed"], pendingTasks: 0, context: null, storageMode };
  }

  if (!existsSync(handoffDir)) {
    return { understanding: "No handoff context found.", nextActions: ["Run `/handoff save` to create context"], risks: ["No handoff directory"], pendingTasks: 0, context: null, storageMode };
  }

  let ctx = loadContextJson(handoffDir);
  if (!ctx) {
    const mdPath = join(handoffDir, "HANDOFF.md");
    if (!existsSync(mdPath)) return { understanding: "No readable context.", nextActions: ["Run `/handoff save`"], risks: ["Invalid state"], pendingTasks: 0, context: null, storageMode };
    const parsed = parseHandoffMd(readFileSync(mdPath, "utf-8"));
    ctx = { version: "1.0.0", timestamp: new Date().toISOString(), agent: "unknown", project: parsed.project || "unknown", current_goal: parsed.current_goal || "", status: parsed.status || "unknown", completed: parsed.completed || [], modified_files: parsed.modified_files || [], todos: parsed.todos || [], blockers: parsed.blockers || [], decisions: [], next_steps: parsed.next_steps || [], git: parsed.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false }, risks: parsed.risks || [], notes: "(parsed from HANDOFF.md)" };
  }

  const parts = [`Project: ${ctx.project}`, `Status: ${ctx.status}`];
  if (ctx.current_goal) parts.push(`Goal: ${ctx.current_goal.split("\n")[0]}`);
  if (ctx.completed.length) parts.push(`Completed: ${ctx.completed.length} items`);
  if (ctx.git.branch !== "unknown") parts.push(`Branch: ${ctx.git.branch}`);
  const pending = ctx.todos.filter((t) => t.status === "pending");
  if (pending.length) parts.push(`Pending tasks: ${pending.length}`);
  const understanding = parts.join(" | ");

  const actions = [...ctx.next_steps];
  const highP = ctx.todos.filter((t) => t.priority === "high" && t.status === "pending");
  for (const t of highP.slice(0, 2)) actions.push(`[HIGH] ${t.task}`);
  if (ctx.blockers.length) actions.push(`Resolve blocker: ${ctx.blockers[0]}`);
  if (mode === "auto") {
    if (ctx.git.is_dirty) actions.push("Review and commit pending changes");
    const medP = ctx.todos.filter((t) => t.priority === "medium" && t.status === "pending");
    if (medP.length) actions.push(`Address ${medP.length} medium-priority TODO items`);
  }
  if (!actions.length) actions.push("Review current context and define next steps");

  const risks = [...ctx.risks];
  if (ctx.blockers.length) risks.push(`Active blocker: ${ctx.blockers[0]}`);
  if (ctx.git.is_dirty) risks.push("Uncommitted changes in working directory");
  if (ctx.timestamp) { const h = (Date.now() - new Date(ctx.timestamp).getTime()) / 3600000; if (h > 24) risks.push(`Handoff is ${Math.round(h)}h old - may be stale`); }

  if (mode === "merge") {
    const branch = runCommand("git branch --show-current");
    if (branch && branch !== ctx.git.branch) risks.push(`Branch mismatch: handoff on '${ctx.git.branch}', current on '${branch}'`);
    if (ctx.git.latest_commit !== "unknown") { const c = runCommand(`git rev-list --count ${ctx.git.latest_commit}..HEAD`); const n = parseInt(c); if (!isNaN(n) && n > 0) actions.unshift(`Sync with ${n} new commit(s) since handoff`); }
  }

  return { understanding: filterSensitive(understanding), nextActions: actions.slice(0, 8).map(filterSensitive), risks: risks.map(filterSensitive), pendingTasks: pending.length, context: ctx, storageMode };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || "default";
if (!["default", "auto", "merge"].includes(mode)) { console.error(`Error: Unknown mode '${mode}'`); process.exit(1); }

try {
  const result = load(mode);
  const lines = [`Storage: ${result.storageMode}`, "", "Current understanding:", result.understanding, "", "Recommended next actions:"];
  result.nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push("");
  if (result.risks.length) { lines.push("Potential risks:"); result.risks.forEach((r) => lines.push(`- ${r}`)); lines.push(""); }
  if (result.pendingTasks) lines.push(`Pending tasks: ${result.pendingTasks}`);
  if (mode === "auto" && result.context) { lines.push("", "---", "Auto-analysis:", `  Project: ${result.context.project}`, `  Agent: ${result.context.agent}`, `  Last saved: ${result.context.timestamp}`, `  Branch: ${result.context.git.branch}`); }
  console.log(lines.join("\n"));
} catch (err) { console.error(`Error: ${err.message}`); process.exit(1); }
