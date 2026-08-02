#!/usr/bin/env -S deno run --allow-read --allow-run

/**
 * Handoff Protocol - Load Script
 *
 * Reads and analyzes handoff context from .handoff/ directory.
 *
 * Usage:
 *   deno run --allow-read --allow-run load.ts [mode] [--focus "current task"] [--budget N] [--full]
 *
 * Modes:
 *   (default) - Standard read and summarize
 *   auto      - Auto-infer next steps with detailed analysis
 *   merge     - Merge with current git context
 *
 * Compiler flags (v2.1, require a readable context map):
 *   --focus   - Compile the map down to nodes relevant to this text
 *   --budget  - Estimated token limit for the compiled map (default 4000, min 512)
 *   --full    - Return the entire map; overrides --focus and --budget
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { exists } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  contextMapHasContent,
  filterSensitive,
  MAP_FILENAME,
  mergeContextMapWithJson,
  normalizeNodeText,
  parseContextMap,
  type ParsedMap,
} from "./context-map.ts";
import {
  compileContext,
  compileV3Context,
  DEFAULT_BUDGET,
  MIN_BUDGET,
  validateBudget,
} from "./context-compiler.mjs";
import { sha256Hex, viewTamperWarnings } from "./views.mjs";
import { loadHandoffState } from "./handoff-state.mjs";
import { detectLayout } from "./migrate-v3.mjs";
import { validateProjectConfig } from "./config.mjs";

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
  compiled?: CompileDiagnostics | null;
}

/** Compiler flags parsed from the CLI (`--focus/--budget/--full`). */
interface CompileRequest {
  focus?: string;
  budget?: number;
  full: boolean;
}

/** Diagnostics returned alongside the load result after a compilation. */
interface CompileDiagnostics {
  focus: string;
  budget: number;
  selectedPaths: string[];
  omittedCount: number;
  estimatedTokens: number;
  overflow: boolean;
  fallbackReason: string | null;
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

/**
 * Read `.handoff/context-map.md`. Returns null when the map is absent, empty,
 * or malformed (no recognizable semantic sections) so callers can fall back
 * to the legacy context.json / HANDOFF.md path.
 */
async function loadContextMap(handoffDir: string): Promise<ParsedMap | null> {
  const mapPath = join(handoffDir, MAP_FILENAME);

  if (!await exists(mapPath)) {
    return null;
  }

  try {
    const content = await Deno.readTextFile(mapPath);
    if (!content.trim()) return null;
    const parsed = parseContextMap(content) as ParsedMap | null;
    return contextMapHasContent(parsed) ? parsed : null;
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

/**
 * Standalone-CLI focus fallback (the Skill passes the current user request
 * instead): Current Goal plus active (incomplete) Tasks.
 */
function defaultFocusFromMap(map: ParsedMap): string {
  const parts: string[] = [];
  for (const node of map.sections.goal || []) parts.push(node.text);
  for (const node of map.sections.tasks || []) if (!node.checked) parts.push(node.text);
  return parts.map((t) => normalizeNodeText(t)).join(" ");
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

  if (result.compiled) {
    const c = result.compiled;
    lines.push("");
    lines.push("Context compiler:");
    lines.push(`  Focus: ${filterSensitive(c.focus)}`);
    lines.push(`  Budget: ${c.budget} estimated tokens`);
    lines.push(`  Selected: ${c.selectedPaths.join(", ")}`);
    lines.push(`  Omitted: ${c.omittedCount} node(s)`);
    lines.push(`  Estimated tokens: ${c.estimatedTokens}`);
    lines.push(`  Overflow: ${c.overflow ? "yes" : "no"}`);
    if (c.fallbackReason) lines.push(`  Fallback: ${c.fallbackReason}`);
  }

  return lines.join("\n");
}

// ── v3 loading ───────────────────────────────────────────────────────────────

const v3Io = {
  readFile: (p: string) => Deno.readTextFile(p),
};

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

async function loadV3State(handoffDir: string) {
  try {
    return await loadHandoffState(v3Io, handoffDir);
  } catch {
    return null;
  }
}

/** Project a canonical v3 state into HandoffContext-shaped fields. */
function v3StateToContext(state: never, json: HandoffContext | null): HandoffContext {
  const st = state as {
    map: { sections: Record<string, { label: string; priority?: string; checked?: boolean }[]> };
  };
  const labels = (key: string) => (st.map.sections[key] || []).map((n) => n.label);
  const todos = (st.map.sections.tasks || []).map((n) => ({
    task: n.label,
    priority: n.priority || "medium",
    status: n.checked ? "completed" : "pending",
  }));
  return {
    version: (json as unknown as { protocolVersion?: string } | null)?.protocolVersion || "3.0.0",
    timestamp: json?.timestamp || "",
    agent: json?.agent || "unknown",
    project: json?.project || "unknown",
    current_goal: labels("goals").join("\n"),
    status: labels("status").join("\n") || "unknown",
    completed: [],
    modified_files: [],
    todos,
    blockers: [],
    decisions: labels("decisions"),
    next_steps: [],
    git: json?.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
    risks: labels("risks"),
    notes: labels("notes").join("\n"),
  } as unknown as HandoffContext;
}

// ── Main Load Logic ──────────────────────────────────────────────────────────

async function load(mode: string, compile: CompileRequest | null = null): Promise<LoadResult> {
  const cwd = Deno.cwd();
  const handoffDir = join(cwd, ".handoff");

  // Read storage config
  const storageConfig = await readStorageConfig(cwd);
  if (storageConfig) {
    // .handoff.config.json is portable project configuration; refuse to load
    // from a config that carries non-portable paths or sensitive values.
    const result = validateProjectConfig(storageConfig);
    if (!result.valid) {
      console.error("Error: invalid .handoff.config.json:");
      for (const err of result.errors) console.error(`  - ${err}`);
      console.error("Fix the file, or remove it and run `/handoff init` to reconfigure storage.");
      Deno.exit(1);
    }
  }
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

  const layout = await layoutOfDir(handoffDir);
  let ctx = await loadContextJson(handoffDir);
  let compileDiagnostics: CompileDiagnostics | null = null;

  if (layout === "v3") {
    // Canonical v3 state: directory + content files. context.json supplements
    // machine state (git, timestamps); the generated view is never a source.
    const state = await loadV3State(handoffDir);
    if (state) {
      const storedViewHash = (ctx as { hashes?: Record<string, string> } | null)?.hashes?.["views/HANDOFF.md"];
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
          // Missing views are regenerated on the next save.
        }
      }
      for (const diagnostic of (state as { diagnostics?: string[] }).diagnostics || []) {
        console.error(`Note: ${diagnostic}`);
      }

      let effective = state;
      if (compile) {
        const defaultFocus = [
          ...(((state as never) as { map: { sections: { goals: { label: string }[] } } }).map.sections.goals || []).map((n) => n.label),
          ...(((state as never) as { map: { sections: { tasks: { label: string; checked?: boolean }[] } } }).map.sections.tasks || []).filter((n) => !n.checked).map((n) => n.label),
        ].map((t) => normalizeNodeText(t)).join(" ");
        const focus = compile.full ? "" : (compile.focus ?? defaultFocus);
        const compiled = compileV3Context({ state, focus, budget: compile.budget, full: compile.full } as never) as {
          state: { map: unknown; content: unknown };
          selectedIds: string[];
          omittedCount: number;
          estimatedTokens: number;
          overflow: boolean;
          fallbackReason: string | null;
        };
        effective = { ...(state as object), map: compiled.state.map, content: compiled.state.content } as never;
        compileDiagnostics = {
          focus: compile.full ? "(full map)" : focus,
          budget: compile.budget ?? DEFAULT_BUDGET,
          selectedPaths: compiled.selectedIds,
          omittedCount: compiled.omittedCount,
          estimatedTokens: compiled.estimatedTokens,
          overflow: compiled.overflow,
          fallbackReason: compiled.fallbackReason,
        };
      }
      ctx = v3StateToContext(effective as never, ctx);
    } else {
      // Present-but-unreadable v3 state: the generated view is the last
      // read-only fallback (semantics recover on the next save).
      const viewPath = join(handoffDir, "views", "HANDOFF.md");
      if (!await exists(viewPath)) {
        return {
          understanding: "Handoff directory exists but contains no readable context.",
          nextActions: ["Run `/handoff save` to regenerate context"],
          risks: ["Invalid handoff state - no readable files"],
          pendingTasks: 0,
          context: null,
          storageMode,
        };
      }
      const parsed = parseHandoffMd(await Deno.readTextFile(viewPath));
      ctx = {
        version: "3.0.0",
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
        notes: "(parsed from views/HANDOFF.md)",
      };
    }
  } else {
    // v2 / legacy path (read-only; the next save migrates to v3).
    const map = await loadContextMap(handoffDir);

    // Generated views are never a semantic source. Warn when an on-disk view
    // no longer matches the hash stored by the last save (manual edit); the
    // map stays authoritative regardless.
    if (ctx && (ctx as { views?: Record<string, string> }).views) {
      const storedViews = (ctx as unknown as { views: Record<string, string> }).views;
      const currentContents: Record<string, string> = {};
      for (const name of Object.keys(storedViews)) {
        try {
          currentContents[name] = await Deno.readTextFile(join(handoffDir, name));
        } catch {
          // Missing views are regenerated on the next save.
        }
      }
      for (const warning of viewTamperWarnings(storedViews, currentContents)) {
        console.error(warning);
      }
    }

    if (map) {
      let effectiveMap = map;
      if (compile) {
        const focus = compile.full ? "" : (compile.focus ?? defaultFocusFromMap(map));
        const compiled = compileContext(map, {
          focus,
          budget: compile.budget,
          full: compile.full,
        }) as {
          map: ParsedMap;
          selectedPaths: string[];
          omittedCount: number;
          estimatedTokens: number;
          overflow: boolean;
          fallbackReason: string | null;
        };
        effectiveMap = compiled.map;
        compileDiagnostics = {
          focus: compile.full ? "(full map)" : focus,
          budget: compile.budget ?? DEFAULT_BUDGET,
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
      console.error("Warning: context-map.md and context.json missing or invalid. Falling back to HANDOFF.md parsing.");

      const handoffMd = await loadHandoffMd(handoffDir);
      if (!handoffMd) {
        console.error("Error: No readable context found in .handoff/ (checked context-map.md, context.json, HANDOFF.md)");
        console.error("Run `/handoff save` to regenerate the handoff files.");
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

    if (layout === "v2" || layout === "legacy") {
      console.error(`Note: ${layout === "v2" ? "v2" : "legacy (pre-v2)"} handoff format detected. Run \`/handoff save\` to migrate to v3; originals are backed up under .handoff/history/migrations/ automatically.`);
    }
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
    compiled: compileDiagnostics,
  };
}

// ── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parse(Deno.args, {
    default: { _: ["default"] },
    string: ["focus", "budget"],
    boolean: ["full"],
  });

  // /handoff load [auto|merge] [--focus "current task"] [--budget N] [--full]
  const allowedFlags = new Set(["_", "focus", "budget", "full"]);
  for (const key of Object.keys(args)) {
    if (!allowedFlags.has(key)) {
      console.error(`Error: Unknown flag '--${key}'`);
      Deno.exit(1);
    }
  }

  const mode = args._[0]?.toString() || "default";
  const validModes = ["default", "auto", "merge"];
  if (!validModes.includes(mode)) {
    console.error(`Error: Unknown mode '${mode}'`);
    console.error(`Valid modes: ${validModes.join(", ")}`);
    Deno.exit(1);
  }

  // std flags cannot distinguish a bare `--focus` from an empty value; both
  // are rejected, matching the Node CLI's error and exit code.
  if (args.focus !== undefined && args.focus === "") {
    console.error("Error: --focus requires a value");
    Deno.exit(1);
  }

  let compile: CompileRequest | null = null;
  if (args.focus !== undefined || args.budget !== undefined || args.full) {
    let budget: number | undefined;
    if (args.budget !== undefined) {
      try {
        budget = validateBudget(Number(args.budget));
      } catch {
        console.error(`Error: invalid --budget value '${args.budget}': expected an integer >= ${MIN_BUDGET}`);
        Deno.exit(1);
      }
    }
    compile = { focus: args.focus, budget, full: !!args.full };
  }

  try {
    const result = await load(mode, compile);
    console.log(formatOutput(result, mode));
  } catch (err) {
    console.error(`Error during load: ${err instanceof Error ? err.message : err}`);
    Deno.exit(1);
  }
}

main();
