#!/usr/bin/env node

/**
 * Handoff Protocol - Load Script (Node.js Reference Implementation)
 *
 * Usage:
 *   node load.mjs [mode] [--focus "current task"] [--budget N] [--full]
 *
 * Modes:
 *   (default) - Standard read and summarize
 *   auto      - Auto-infer next steps
 *   merge     - Merge with current git context
 *
 * Compiler flags (v2.1, require a readable context map):
 *   --focus   - Compile the map down to nodes relevant to this text
 *   --budget  - Estimated token limit for the compiled map (default 4000, min 512)
 *   --full    - Return the entire map; overrides --focus and --budget
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  contextMapHasContent,
  filterSensitive,
  MAP_FILENAME,
  mergeContextMapWithJson,
  normalizeNodeText,
  parseContextMap,
} from "./context-map.mjs";
import {
  compileContext,
  compileV3Context,
  DEFAULT_BUDGET,
  MIN_BUDGET,
  validateBudget,
} from "../context-compiler.mjs";
import { loadHandoffState } from "../handoff-state.mjs";
import { detectLayout } from "../migrate-v3.mjs";
import { sha256Hex, viewTamperWarnings } from "../views.mjs";
import { validateProjectConfig } from "../config.mjs";

// ── Security ─────────────────────────────────────────────────────────────────
// SENSITIVE_PATTERNS and filterSensitive live in ./context-map.mjs (shared with
// the Deno runtime and the test suites).

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
      case "todo": case "tasks": result.todos.push({ task: item.replace(/^\[[ x]\]\s*/, ""), priority: "medium", status: item.includes("[x]") ? "completed" : "pending" }); break;
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

/**
 * Read `.handoff/context-map.md`. Returns null when the map is absent, empty,
 * or malformed (no recognizable semantic sections) so callers can fall back
 * to the legacy context.json / HANDOFF.md path.
 */
function loadContextMap(handoffDir) {
  const mapPath = join(handoffDir, MAP_FILENAME);
  if (!existsSync(mapPath)) return null;
  try {
    const content = readFileSync(mapPath, "utf-8");
    if (!content.trim()) return null;
    const parsed = parseContextMap(content);
    return contextMapHasContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Standalone-CLI focus fallback (the Skill passes the current user request
 * instead): Current Goal plus active (incomplete) Tasks.
 */
function defaultFocusFromMap(map) {
  const parts = [];
  for (const node of map.sections.goal || []) parts.push(node.text);
  for (const node of map.sections.tasks || []) if (!node.checked) parts.push(node.text);
  return parts.map((t) => normalizeNodeText(t)).join(" ");
}

// ── v3 loading ───────────────────────────────────────────────────────────────

const v3Io = {
  readFile: async (p) => readFileSync(p, "utf-8"),
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

async function loadV3State(handoffDir) {
  try {
    return await loadHandoffState(v3Io, handoffDir);
  } catch {
    return null;
  }
}

/** Project a canonical v3 state into HandoffContext-shaped fields. */
function v3StateToContext(state, json) {
  const labels = (key) => (state.map.sections[key] || []).map((n) => n.label);
  const todos = (state.map.sections.tasks || []).map((n) => ({
    task: n.label,
    priority: n.priority || "medium",
    status: n.checked ? "completed" : "pending",
  }));
  return {
    version: (json && json.protocolVersion) || "3.0.0",
    timestamp: (json && json.timestamp) || "",
    agent: (json && json.agent) || "unknown",
    project: (json && json.project) || "unknown",
    current_goal: labels("goals").join("\n"),
    status: labels("status").join("\n") || "unknown",
    completed: [],
    modified_files: [],
    todos,
    blockers: [],
    decisions: labels("decisions"),
    next_steps: [],
    git: (json && json.git) || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
    risks: labels("risks"),
    notes: labels("notes").join("\n"),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function load(mode, compileOpts = null) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");
  const storageConfig = readStorageConfig(cwd);
  if (storageConfig) {
    // .handoff.config.json is portable project configuration; refuse to load
    // from a config that carries non-portable paths or sensitive values.
    const result = validateProjectConfig(storageConfig);
    if (!result.valid) {
      console.error("Error: invalid .handoff.config.json:");
      for (const err of result.errors) console.error(`  - ${err}`);
      console.error("Fix the file, or remove it and run `/handoff init` to reconfigure storage.");
      process.exit(1);
    }
  }
  const storageMode = storageConfig?.storage.mode || "direct";

  if (storageMode === "submodule" && !ensureSubmoduleReady(cwd)) {
    return { understanding: "Unable to access .handoff submodule.", nextActions: ["Check SSH key or credentials", "Run: git submodule update --init --recursive .handoff"], risks: ["Submodule access failed"], pendingTasks: 0, context: null, storageMode };
  }

  if (!existsSync(handoffDir)) {
    return { understanding: "No handoff context found.", nextActions: ["Run `/handoff save` to create context"], risks: ["No handoff directory"], pendingTasks: 0, context: null, storageMode };
  }

  const layout = layoutOfDir(handoffDir);
  let ctx = loadContextJson(handoffDir);
  let compileDiagnostics = null;

  if (layout === "v3") {
    // Canonical v3 state: directory + content files. context.json supplements
    // machine state (git, timestamps); the generated view is never a source.
    const state = await loadV3State(handoffDir);
    if (state) {
      const storedViewHash = ctx && ctx.hashes && ctx.hashes["views/HANDOFF.md"];
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
          // Missing views are regenerated on the next save.
        }
      }
      for (const diagnostic of state.diagnostics || []) console.error(`Note: ${diagnostic}`);

      let effective = state;
      if (compileOpts) {
        const defaultFocus = [
          ...(state.map.sections.goals || []).map((n) => n.label),
          ...(state.map.sections.tasks || []).filter((n) => !n.checked).map((n) => n.label),
        ].map((t) => normalizeNodeText(t)).join(" ");
        const focus = compileOpts.full ? "" : (compileOpts.focus ?? defaultFocus);
        const compiled = compileV3Context({ state, focus, budget: compileOpts.budget, full: compileOpts.full });
        effective = { ...state, map: compiled.state.map, content: compiled.state.content };
        compileDiagnostics = {
          focus: compileOpts.full ? "(full map)" : focus,
          budget: compileOpts.budget ?? DEFAULT_BUDGET,
          selectedPaths: compiled.selectedIds,
          omittedCount: compiled.omittedCount,
          estimatedTokens: compiled.estimatedTokens,
          overflow: compiled.overflow,
          fallbackReason: compiled.fallbackReason,
        };
      }
      ctx = v3StateToContext(effective, ctx);
    } else {
      // Present-but-unreadable v3 state: the generated view is the last
      // read-only fallback (semantics recover on the next save).
      const viewPath = join(handoffDir, "views", "HANDOFF.md");
      if (!existsSync(viewPath)) {
        return { understanding: "No readable context.", nextActions: ["Run `/handoff save`"], risks: ["Invalid state"], pendingTasks: 0, context: null, storageMode };
      }
      const parsed = parseHandoffMd(readFileSync(viewPath, "utf-8"));
      ctx = { version: "3.0.0", timestamp: new Date().toISOString(), agent: "unknown", project: parsed.project || "unknown", current_goal: parsed.current_goal || "", status: parsed.status || "unknown", completed: parsed.completed || [], modified_files: parsed.modified_files || [], todos: parsed.todos || [], blockers: parsed.blockers || [], decisions: [], next_steps: parsed.next_steps || [], git: parsed.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false }, risks: parsed.risks || [], notes: "(parsed from views/HANDOFF.md)" };
    }
  } else {
    // v2 / legacy path (read-only; the next save migrates to v3).
    const map = loadContextMap(handoffDir);

    // Generated views are never a semantic source. Warn when an on-disk view
    // no longer matches the hash stored by the last save (manual edit); the
    // map stays authoritative regardless.
    if (ctx && ctx.views) {
      const currentContents = {};
      for (const name of Object.keys(ctx.views)) {
        try {
          currentContents[name] = readFileSync(join(handoffDir, name), "utf-8");
        } catch {
          // Missing views are regenerated on the next save.
        }
      }
      for (const warning of viewTamperWarnings(ctx.views, currentContents)) {
        console.error(warning);
      }
    }

    if (map) {
      let effectiveMap = map;
      if (compileOpts) {
        const focus = compileOpts.full ? "" : (compileOpts.focus ?? defaultFocusFromMap(map));
        const compiled = compileContext(map, {
          focus,
          budget: compileOpts.budget,
          full: compileOpts.full,
        });
        effectiveMap = compiled.map;
        compileDiagnostics = {
          focus: compileOpts.full ? "(full map)" : focus,
          budget: compileOpts.budget ?? DEFAULT_BUDGET,
          selectedPaths: compiled.selectedPaths,
          omittedCount: compiled.omittedCount,
          estimatedTokens: compiled.estimatedTokens,
          overflow: compiled.overflow,
          fallbackReason: compiled.fallbackReason,
        };
      }
      ctx = mergeContextMapWithJson(effectiveMap, ctx);
    } else if (ctx && !Array.isArray(ctx.todos)) {
      // v2 context.json carries no semantic fields; without a readable map it
      // cannot stand alone — fall through to the HANDOFF.md view.
      ctx = null;
    }

    // Fallback: parse HANDOFF.md if the map is unusable and context.json is
    // missing/invalid (legacy 1.x handoff).
    if (!ctx) {
      const mdPath = join(handoffDir, "HANDOFF.md");
      if (!existsSync(mdPath)) return { understanding: "No readable context.", nextActions: ["Run `/handoff save`"], risks: ["Invalid state"], pendingTasks: 0, context: null, storageMode };
      const parsed = parseHandoffMd(readFileSync(mdPath, "utf-8"));
      ctx = { version: "1.0.0", timestamp: new Date().toISOString(), agent: "unknown", project: parsed.project || "unknown", current_goal: parsed.current_goal || "", status: parsed.status || "unknown", completed: parsed.completed || [], modified_files: parsed.modified_files || [], todos: parsed.todos || [], blockers: parsed.blockers || [], decisions: [], next_steps: parsed.next_steps || [], git: parsed.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false }, risks: parsed.risks || [], notes: "(parsed from HANDOFF.md)" };
    }

    if (layout === "v2" || layout === "legacy") {
      console.error(`Note: ${layout === "v2" ? "v2" : "legacy (pre-v2)"} handoff format detected. Run \`/handoff save\` to migrate to v3; originals are backed up under .handoff/history/migrations/ automatically.`);
    }
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

  return { understanding: filterSensitive(understanding), nextActions: actions.slice(0, 8).map(filterSensitive), risks: risks.map(filterSensitive), pendingTasks: pending.length, context: ctx, storageMode, compiled: compileDiagnostics };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

// /handoff load [auto|merge] [--focus "current task"] [--budget N] [--full]
function parseCliArgs(argv) {
  const opts = { mode: "default", compile: null };
  const positionals = [];
  let focus;
  let budget;
  let full = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full") {
      full = true;
    } else if (arg === "--focus" || arg === "--budget") {
      const value = argv[i + 1];
      // An empty --focus is rejected like a missing one (parity with the
      // Deno CLI, which cannot distinguish a bare flag from an empty value).
      if (value === undefined || (arg === "--focus" && value === "")) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      i++;
      if (arg === "--focus") {
        focus = value;
      } else {
        try {
          budget = validateBudget(Number(value));
        } catch {
          console.error(`Error: invalid --budget value '${value}': expected an integer >= ${MIN_BUDGET}`);
          process.exit(1);
        }
      }
    } else if (arg.startsWith("--")) {
      console.error(`Error: Unknown flag '${arg}'`);
      process.exit(1);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length) opts.mode = positionals[0];
  if (focus !== undefined || budget !== undefined || full) {
    opts.compile = { focus, budget, full };
  }
  return opts;
}

const cli = parseCliArgs(process.argv.slice(2));
if (!["default", "auto", "merge"].includes(cli.mode)) { console.error(`Error: Unknown mode '${cli.mode}'`); process.exit(1); }

try {
  const result = await load(cli.mode, cli.compile);
  const mode = cli.mode;
  const lines = [`Storage: ${result.storageMode}`, "", "Current understanding:", result.understanding, "", "Recommended next actions:"];
  result.nextActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push("");
  if (result.risks.length) { lines.push("Potential risks:"); result.risks.forEach((r) => lines.push(`- ${r}`)); lines.push(""); }
  if (result.pendingTasks) lines.push(`Pending tasks: ${result.pendingTasks}`);
  if (mode === "auto" && result.context) { lines.push("", "---", "Auto-analysis:", `  Project: ${result.context.project}`, `  Agent: ${result.context.agent}`, `  Last saved: ${result.context.timestamp}`, `  Modified files: ${result.context.modified_files.length}`, `  Branch: ${result.context.git.branch}`); }
  if (result.compiled) {
    const c = result.compiled;
    lines.push("", "Context compiler:");
    lines.push(`  Focus: ${filterSensitive(c.focus)}`);
    lines.push(`  Budget: ${c.budget} estimated tokens`);
    lines.push(`  Selected: ${c.selectedPaths.join(", ")}`);
    lines.push(`  Omitted: ${c.omittedCount} node(s)`);
    lines.push(`  Estimated tokens: ${c.estimatedTokens}`);
    lines.push(`  Overflow: ${c.overflow ? "yes" : "no"}`);
    if (c.fallbackReason) lines.push(`  Fallback: ${c.fallbackReason}`);
  }
  console.log(lines.join("\n"));
} catch (err) { console.error(`Error: ${err.message}`); process.exit(1); }
